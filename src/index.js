import "dotenv/config";
import express from "express";
import { supabase } from "./supabase.js";
import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;

// Base URL for internal API calls
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// Channel for PTO announcements
const PTO_CHANNEL_ID = process.env.PTO_CHANNEL_ID || "C0AD8JE79FA";

// ---------------------------
// PTO Types (fallback util)
// ---------------------------
const PTO_TYPES = {
  "Short-term leave": ["Vacation", "Out Sick", "Jury Duty", "Study", "Marriage", "Relocation"],
  "Extended leave": ["Parental Leave", "Medical Leave"],
  Other: ["Conference"],
};

// helper construir home blocks
function formatDate(d) {
  return d;
}

function statusEmoji(status) {
  if (status === "approved") return "✅";
  if (status === "denied") return "❌";
  if (status === "cancelled") return "🟡";
  return "⏳";
}


function isValidPto(category, type) {
  return PTO_TYPES[category]?.includes(type);
}

function countsAgainstBalance(category, type) {
  // legacy helper; real behavior now is in DB via pto_types.counts_against_balance
  return category === "Short-term leave" && type === "Vacation";
}

function typeKey(category, name) {
  return `${category}::${name}`;
}

async function getPtoType(category, type) {
  const { data, error } = await supabase
    .from("pto_types")
    .select("*")
    .eq("category", category)
    .eq("name", type)
    .single();

  if (error) return { ptoType: null, error };
  return { ptoType: data, error: null };
}

async function getUsedDaysForType(userId, category, type) {
  const { data, error } = await supabase
    .from("pto_requests")
    .select("days_count")
    .eq("user_id", userId)
    .eq("status", "approved")
    .eq("category", category)
    .eq("type", type);

  if (error) return { used: null, error };
  const used = (data || []).reduce((sum, r) => sum + (r.days_count || 0), 0);
  return { used, error: null };
}

function checkEligibility(user, ptoType) {
  if (ptoType.eligibility_rule === "STUDENTS_ONLY" && !user.is_student) {
    return { ok: false, reason: "Only students can request this leave type" };
  }
  return { ok: true };
}

async function requireAdmin(slack_id) {
  const { data, error } = await supabase
    .from("users")
    .select("id, is_admin")
    .eq("slack_id", slack_id)
    .single();

  if (error) return { ok: false, error: "Admin user not found" };
  if (!data.is_admin) return { ok: false, error: "Not authorized (admin only)" };

  return { ok: true, userId: data.id };
}

async function getUserBySlackId(slack_id) {
  const { data, error } = await supabase
    .from("users")
    .select("id, is_admin")
    .eq("slack_id", slack_id)
    .single();

  if (error) return { user: null, error };
  return { user: data, error: null };
}

// Auto-register user if they don't exist (with retry for transient errors)
async function getOrCreateUser(slack_id, slackClient, retries = 3) {
  console.log(`🔍 getOrCreateUser: Looking for ${slack_id} (attempt ${4 - retries}/3)`);
  
  try {
    // First, try to find existing user
    const { data: existingUser, error: findError } = await supabase
      .from("users")
      .select("*")
      .eq("slack_id", slack_id)
      .single();

    // If user found, return immediately
    if (existingUser) {
      console.log(`✅ getOrCreateUser: Found user ${existingUser.name}`);
      return { user: existingUser, created: false, error: null };
    }

    // Handle connection errors with retry
    if (findError && findError.code !== "PGRST116") {
      // PGRST116 = "no rows returned" (expected when user doesn't exist)
      // Any other error (timeout, connection) should be retried
      console.error(`⚠️ DB error finding user: code=${findError.code}, message=${findError.message}`);
      
      if (retries > 0) {
        console.log(`🔄 Retrying in 1 second...`);
        await new Promise(r => setTimeout(r, 1000)); // Wait 1 second
        return getOrCreateUser(slack_id, slackClient, retries - 1);
      }
      return { user: null, created: false, error: `Connection error: ${findError.message}` };
    }
    
    console.log(`📝 User not found, will create new user for ${slack_id}`);
  } catch (e) {
    console.error(`❌ Exception in getOrCreateUser find:`, e.message);
    if (retries > 0) {
      console.log(`🔄 Retrying after exception...`);
      await new Promise(r => setTimeout(r, 1000));
      return getOrCreateUser(slack_id, slackClient, retries - 1);
    }
    return { user: null, created: false, error: e.message };
  }

  // User doesn't exist, get their Slack profile
  try {
    const slackProfile = await slackClient.users.info({ user: slack_id });
    
    if (!slackProfile.ok || !slackProfile.user) {
      return { user: null, created: false, error: "Could not fetch Slack profile" };
    }

    const profile = slackProfile.user;
    const name = profile.real_name || profile.name || `User ${slack_id}`;

    // Create user in Supabase
    const { data: newUser, error: createError } = await supabase
      .from("users")
      .insert([
        {
          name,
          slack_id,
          manager_id: null,
          is_admin: false,
          is_student: false,
          country: null,
        },
      ])
      .select()
      .single();

    if (createError) {
      console.error("Error creating user:", createError);
      return { user: null, created: false, error: createError.message };
    }

    console.log(`✅ Auto-registered new user: ${name} (${slack_id})`);
    return { user: newUser, created: true, error: null };
  } catch (e) {
    console.error("Error in getOrCreateUser:", e);
    return { user: null, created: false, error: e.message };
  }
}

async function canDecideRequest(request_id, deciderUserId, deciderIsAdmin) {
  const { data: reqData, error } = await supabase
    .from("pto_requests")
    .select("id, approver_id, status")
    .eq("id", request_id)
    .single();

  if (error) return { ok: false, error: "Request not found" };

  if (reqData.status !== "pending") {
    return { ok: false, error: `Request is not pending (current: ${reqData.status})` };
  }

  if (deciderIsAdmin) return { ok: true, request: reqData };

  if (!reqData.approver_id) return { ok: false, error: "Request has no approver assigned" };

  const isApprover = reqData.approver_id === deciderUserId;
  if (!isApprover) {
    return { ok: false, error: "Not authorized: only the assigned approver or an admin can decide" };
  }

  return { ok: true, request: reqData };
}

function countBusinessDays(startDateStr, endDateStr) {
  const start = new Date(startDateStr + "T00:00:00");
  const end = new Date(endDateStr + "T00:00:00");

  if (isNaN(start) || isNaN(end)) return null;
  if (end < start) return null;

  let count = 0;
  const d = new Date(start);

  while (d <= end) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ---------------------------
// Slack setup (Bolt)
// ---------------------------
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

slack.error(async (error) => {
  console.error("SLACK_BOLT_ERROR:", error);
});

// ---------------------------
// Express setup
// IMPORTANT ORDER: receiver.router BEFORE express.json()
// ---------------------------
const app = express();

app.use(receiver.router); // Slack endpoints live here: /slack/events
app.use(express.json());

app.use((req, res, next) => {
  console.log("HTTP", req.method, req.url);
  next();
});

app.get("/", (req, res) => res.send("PTO tool alive 🟢"));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "pto-mvp", ts: new Date().toISOString() });
});

// Version endpoint
app.get("/version", (req, res) => {
  res.json({ version: "1.0.0" });
});

// ---------------------------
// Slack: /pto command (help, balance, request modal)
// ---------------------------
slack.command("/pto", async ({ ack, command, respond, client }) => {
  await ack();

  const text = (command.text || "").trim().toLowerCase();

  // Auto-register user if needed
  const { user, created, error: userError } = await getOrCreateUser(command.user_id, client);

  if (userError || !user) {
    return respond(
      "Error al verificar tu usuario. Intenta de nuevo o contacta a un admin."
    );
  }

  // Welcome message for newly registered users
  if (created) {
    await respond(
      `👋 *¡Bienvenido/a a PTO Tool, ${user.name}!*\n\n` +
      `Tu cuenta fue creada automáticamente. Un admin te asignará un manager pronto.\n\n` +
      `Mientras tanto, podés ver tus balances y explorar la app.`
    );
  }

  // HELP
  if (!text || text === "help") {
    let helpText =
      "Comandos:\n" +
      "• `/pto balance` → ver tu balance\n" +
      "• `/pto request` → pedir PTO\n" +
      "• `/pto connect-calendar` → conectar Google Calendar\n";

    if (user.is_admin) {
      helpText +=
        "\n*Admin commands:*\n" +
        "• `/pto admin assign-manager @user @manager` → asignar manager\n" +
        "• `/pto admin team @manager` → ver reportes directos\n" +
        "• `/pto admin set-admin @user true/false` → promover/quitar admin\n";
    }

    return respond(helpText);
  }

  // BALANCE
  if (text === "balance") {
    const { data: types, error: typesError } = await supabase
      .from("pto_types")
      .select("*")
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (typesError) return respond("Error leyendo policy (pto_types).");

    const { data: approved, error: reqError } = await supabase
      .from("pto_requests")
      .select("days_count, category, type")
      .eq("user_id", user.id)
      .eq("status", "approved");

    if (reqError) return respond("Error leyendo tus PTO aprobados.");

    const usedBy = {};
    for (const r of approved || []) {
      const key = `${r.category}::${r.type}`;
      usedBy[key] = (usedBy[key] || 0) + (r.days_count || 0);
    }

    const lines = [];
    lines.push(`*Balance PTO — ${user.name}*`);
    lines.push(user.is_student ? "_Study: habilitado_" : "_Study: no habilitado_");
    lines.push("");

    for (const t of types || []) {
      if (t.eligibility_rule === "STUDENTS_ONLY" && !user.is_student) continue;

      const key = `${t.category}::${t.name}`;
      const used = usedBy[key] || 0;

      if (t.is_unlimited) {
        lines.push(`• *${t.name}*: ∞ (usado: ${used})`);
      } else {
        const allowance = t.annual_allowance_days ?? 0;
        const remaining = t.counts_against_balance ? Math.max(allowance - used, 0) : allowance;
        lines.push(`• *${t.name}*: ${remaining}/${allowance} (usado: ${used})`);
      }
    }

    return respond(lines.join("\n"));
  }

  // REQUEST -> open modal
  if (text === "request") {
    const { data: types, error: typesError } = await supabase
      .from("pto_types")
      .select("*")
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (typesError) return respond("Error leyendo policy (pto_types).");

    const allowedTypes = (types || []).filter(
      (t) => !(t.eligibility_rule === "STUDENTS_ONLY" && !user.is_student)
    );

    const options = allowedTypes.map((t) => ({
      text: { type: "plain_text", text: `${t.name} (${t.category})` },
      value: `${t.category}||${t.name}`,
    }));

    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: "modal",
        callback_id: "pto_request_submit",
        title: { type: "plain_text", text: "Request PTO" },
        submit: { type: "plain_text", text: "Send" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "pto_type_block",
            label: { type: "plain_text", text: "OOO Type" },
            element: {
              type: "static_select",
              action_id: "pto_type",
              placeholder: { type: "plain_text", text: "Select type" },
              options,
            },
          },
          {
            type: "input",
            block_id: "start_date_block",
            label: { type: "plain_text", text: "Start date" },
            element: { type: "datepicker", action_id: "start_date" },
          },
          {
            type: "input",
            block_id: "end_date_block",
            label: { type: "plain_text", text: "End date" },
            element: { type: "datepicker", action_id: "end_date" },
          },
          {
            type: "input",
            block_id: "reason_block",
            optional: true,
            label: { type: "plain_text", text: "Reason (optional)" },
            element: {
              type: "plain_text_input",
              action_id: "reason",
              multiline: true,
            },
          },
        ],
      },
    });

    return;
  }

  // ---------------------------
  // ADMIN COMMANDS
  // ---------------------------
  const originalText = (command.text || "").trim();

  // ADMIN: assign-manager
  if (text.startsWith("admin assign-manager")) {
    if (!user.is_admin) {
      return respond("Solo admins pueden usar este comando.");
    }

    // Parse: /pto admin assign-manager @user @manager
    const mentions = originalText.match(/<@([A-Z0-9]+)\|?[^>]*>/g) || [];
    if (mentions.length !== 2) {
      return respond("Uso: `/pto admin assign-manager @usuario @manager`");
    }

    const targetSlackId = mentions[0].match(/<@([A-Z0-9]+)/)[1];
    const managerSlackId = mentions[1].match(/<@([A-Z0-9]+)/)[1];

    // Get target user
    const { data: targetUser, error: targetError } = await supabase
      .from("users")
      .select("id, name")
      .eq("slack_id", targetSlackId)
      .single();

    if (targetError || !targetUser) {
      return respond(`Usuario <@${targetSlackId}> no está registrado en PTO tool.`);
    }

    // Get manager user
    const { data: managerUser, error: managerError } = await supabase
      .from("users")
      .select("id, name")
      .eq("slack_id", managerSlackId)
      .single();

    if (managerError || !managerUser) {
      return respond(`Manager <@${managerSlackId}> no está registrado en PTO tool.`);
    }

    // Update manager_id
    const { error: updateError } = await supabase
      .from("users")
      .update({ manager_id: managerUser.id })
      .eq("id", targetUser.id);

    if (updateError) {
      return respond(`Error actualizando manager: ${updateError.message}`);
    }

    return respond(`✅ Manager de <@${targetSlackId}> actualizado a <@${managerSlackId}>`);
  }

  // ADMIN: team (ver reportes directos)
  if (text.startsWith("admin team")) {
    if (!user.is_admin) {
      return respond("Solo admins pueden usar este comando.");
    }

    // Parse: /pto admin team @manager
    const mentions = originalText.match(/<@([A-Z0-9]+)\|?[^>]*>/g) || [];
    if (mentions.length !== 1) {
      return respond("Uso: `/pto admin team @manager`");
    }

    const managerSlackId = mentions[0].match(/<@([A-Z0-9]+)/)[1];

    // Get manager user
    const { data: managerUser, error: managerError } = await supabase
      .from("users")
      .select("id, name")
      .eq("slack_id", managerSlackId)
      .single();

    if (managerError || !managerUser) {
      return respond(`Usuario <@${managerSlackId}> no está registrado en PTO tool.`);
    }

    // Get direct reports
    const { data: reports, error: reportsError } = await supabase
      .from("users")
      .select("name, slack_id, is_admin, is_student")
      .eq("manager_id", managerUser.id);

    if (reportsError) {
      return respond(`Error obteniendo reportes: ${reportsError.message}`);
    }

    if (!reports || reports.length === 0) {
      return respond(`<@${managerSlackId}> no tiene reportes directos.`);
    }

    const lines = [`*Reportes directos de <@${managerSlackId}>:*\n`];
    for (const r of reports) {
      const tags = [];
      if (r.is_admin) tags.push("admin");
      if (r.is_student) tags.push("student");
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      lines.push(`• <@${r.slack_id}>${tagStr}`);
    }

    return respond(lines.join("\n"));
  }

  // ADMIN: set-admin
  if (text.startsWith("admin set-admin")) {
    if (!user.is_admin) {
      return respond("Solo admins pueden usar este comando.");
    }

    // Parse: /pto admin set-admin @user true/false
    const mentions = originalText.match(/<@([A-Z0-9]+)\|?[^>]*>/g) || [];
    if (mentions.length !== 1) {
      return respond("Uso: `/pto admin set-admin @usuario true/false`");
    }

    const targetSlackId = mentions[0].match(/<@([A-Z0-9]+)/)[1];
    const isAdminValue = text.includes("true");
    const isFalseValue = text.includes("false");

    if (!isAdminValue && !isFalseValue) {
      return respond("Uso: `/pto admin set-admin @usuario true/false`");
    }

    // Get target user
    const { data: targetUser, error: targetError } = await supabase
      .from("users")
      .select("id, name, is_admin")
      .eq("slack_id", targetSlackId)
      .single();

    if (targetError || !targetUser) {
      return respond(`Usuario <@${targetSlackId}> no está registrado en PTO tool.`);
    }

    // Update is_admin
    const { error: updateError } = await supabase
      .from("users")
      .update({ is_admin: isAdminValue })
      .eq("id", targetUser.id);

    if (updateError) {
      return respond(`Error actualizando admin status: ${updateError.message}`);
    }

    const action = isAdminValue ? "promovido a admin" : "removido como admin";
    return respond(`✅ <@${targetSlackId}> ${action}`);
  }

  return respond("No entendí. Probá `/pto help`.");
});

// ---------------------------
// Slack: modal submit -> create request -> DM manager with buttons
// ---------------------------
slack.view("pto_request_submit", async ({ ack, body, view, client }) => {

  let acked = false;

  const safeAck = async (payload) => {
    if (acked) return;
    acked = true;
    await ack(payload);
  };


  try {
    const slack_id = body.user.id;

    const typeValue = view.state.values.pto_type_block.pto_type.selected_option.value;
    const [category, type] = typeValue.split("||");

    const start_date = view.state.values.start_date_block.start_date.selected_date;
    const end_date = view.state.values.end_date_block.end_date.selected_date;

    const reason = view.state.values.reason_block?.reason?.value || null;

    // ⚠️ IMPORTANT: si esto tarda >3s, Slack se queja igual
    const resp = await fetch(`${BASE_URL}/pto/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slack_id, category, type, start_date, end_date, reason }),
    });

    const json = await resp.json();

    // ❌ Error: mostramos feedback en el MODAL
    if (!resp.ok) {
      // balance excedido -> error en el bloque de end_date (podría ser start o end)
      if (json?.error === "Request exceeds remaining balance" && json?.details) {
        const d = json.details;
        await ack({
          response_action: "errors",
          errors: {
            end_date_block: `Te quedan ${d.remaining_days} días de ${type}. Pediste ${d.requested_days}.`,
          },
        });
        return;
      }

      // solapamiento -> también lo marcamos en fechas
      if (json?.error === "Request overlaps with an existing PTO request") {
        await ack({
          response_action: "errors",
          errors: {
            end_date_block: "Estas fechas se solapan con otra solicitud (pending/approved).",
          },
        });
        return;
      }

      // fallback general
      await safeAck({
        response_action: "errors",
        errors: { end_date_block: json?.error || "No se pudo registrar la solicitud." },
      });
      return;
    }

    // ✅ OK: cerramos modal
    await safeAck({ response_action: "clear" });

    const request = json.request;

    // DM manager con botones
    const { data: approver } = await supabase
      .from("users")
      .select("slack_id, name")
      .eq("id", request.approver_id)
      .single();

    if (!approver?.slack_id) return;

    const dm = await client.conversations.open({ users: approver.slack_id });

    await client.chat.postMessage({
      channel: dm.channel.id,
      text: "PTO approval request",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `*PTO approval*\n` +
              `• Requester: <@${slack_id}>\n` +
              `• Type: *${type}*\n` +
              `• Dates: *${start_date} → ${end_date}*\n` +
              `• Business days: *${json.computed_days}*\n` +
              (reason ? `• Reason: ${reason}\n` : ""),
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve ✅" },
              style: "primary",
              action_id: "pto_approve_btn",
              value: request.id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny ❌" },
              style: "danger",
              action_id: "pto_deny_btn",
              value: request.id,
            },
          ],
        },
      ],
    });

    // opcional: DM al usuario confirmando (ya no es necesario porque modal cerró, pero queda rico)
    const dmUser = await client.conversations.open({ users: slack_id });
    await client.chat.postMessage({
      channel: dmUser.channel.id,
      text: `✅ Solicitud enviada a aprobación: *${type}* (${start_date} → ${end_date})`,
    });
  } catch (e) {
    console.error("pto_request_submit error", e);
    // si explota algo, intentamos mostrar error en modal
    await safeAck({
      response_action: "errors",
      errors: { end_date_block: "Error inesperado. Probá de nuevo." },
    });
  }
});


// ---------------------------
// Slack: approve/deny buttons
// ---------------------------
slack.action("pto_approve_btn", async ({ ack, body, client }) => {
  await ack();

  const request_id = body.actions[0].value;
  const decided_by_slack_id = body.user.id;

  const resp = await fetch(`${BASE_URL}/pto/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id, decided_by_slack_id }),
  });

  const json = await resp.json();

  if (!resp.ok) {
    await client.chat.postMessage({
      channel: body.channel.id,
      text: `❌ No se pudo aprobar: ${json.error || "error"}`,
    });
    await client.views.publish({
      user_id: body.user.id,
      view: { type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Reabrí Home para refrescar." } }] },
    });
    return;
  }

  await client.chat.postMessage({
    channel: body.channel.id,
    text: "✅ Approved",
  });

  await client.views.publish({
    user_id: body.user.id,
    view: { type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ Listo. Reabrí Home para refrescar." } }] },
  });
  await publishHome(client, body.user.id);

  // refresca Home del requester
  const { data: req } = await supabase
    .from("pto_requests")
    .select("user_id")
    .eq("id", request_id)
    .single();

  if (req?.user_id) {
    const { data: ru } = await supabase
      .from("users")
      .select("slack_id")
      .eq("id", req.user_id)
      .single();

    if (ru?.slack_id) {
      await publishHome(client, ru.slack_id);
    }
  }
});

slack.action("pto_deny_btn", async ({ ack, body, client }) => {
  await ack();

  const request_id = body.actions[0].value;
  const decided_by_slack_id = body.user.id;

  const resp = await fetch(`${BASE_URL}/pto/deny`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id, decided_by_slack_id }),
  });

  const json = await resp.json();

  if (!resp.ok) {
    await client.chat.postMessage({
      channel: body.channel.id,
      text: `❌ No se pudo denegar: ${json.error || "error"}`,
    });
    return;
  }

  await client.chat.postMessage({
    channel: body.channel.id,
    text: "❌ Denied",
  });
  await publishHome(client, body.user.id);

  // refresca Home del requester
  const { data: req } = await supabase
    .from("pto_requests")
    .select("user_id")
    .eq("id", request_id)
    .single();

  if (req?.user_id) {
    const { data: ru } = await supabase
      .from("users")
      .select("slack_id")
      .eq("id", req.user_id)
      .single();

    if (ru?.slack_id) {
      await publishHome(client, ru.slack_id);
    }
  }
});

// ---------------------------
// Slack: cancel button
// ---------------------------
slack.action("pto_cancel_btn", async ({ ack, body, client }) => {
  await ack();

  // Note: This handler only fires when user confirms the cancellation.
  // If user clicks "No, keep it", Slack doesn't send the event.

  const request_id = body.actions[0]?.value;
  const slack_id = body.user.id;

  if (!request_id) {
    console.error("❌ Cancel: request_id missing from action", body.actions);
    return;
  }

  console.log(`🔍 Cancel: request_id=${request_id}, slack_id=${slack_id}`);

  const resp = await fetch(`${BASE_URL}/pto/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: String(request_id), slack_id }),
  });

  const json = await resp.json();

  if (!resp.ok) {
    console.error(`❌ Cancel failed: ${json.error || "error"}`);
    // Send DM to user if error
    try {
      const dm = await client.conversations.open({ users: slack_id });
      await client.chat.postMessage({
        channel: dm.channel.id,
        text: `❌ No se pudo cancelar: ${json.error || "error"}`,
      });
    } catch (e) {
      console.error("Error sending DM:", e);
    }
    return;
  }

  console.log(`✅ Cancel successful: request ${request_id} cancelled`);

  // Success: refresh Home tab and send confirmation
  try {
    await publishHome(client, slack_id);
    
    // Send confirmation DM
    const dm = await client.conversations.open({ users: slack_id });
    await client.chat.postMessage({
      channel: dm.channel.id,
      text: `✅ Solicitud cancelada exitosamente.`,
    });
  } catch (e) {
    console.error("Error refreshing home or sending confirmation:", e);
  }
});

// ---------------------------
// API: users
// ---------------------------
app.post("/users", async (req, res) => {
  const { name, slack_id, country, manager_id, annual_allowance_days } = req.body;

  const { data, error } = await supabase
    .from("users")
    .insert([
      {
        name,
        slack_id,
        country,
        manager_id: manager_id || null,
        annual_allowance_days: annual_allowance_days ?? 20,
      },
    ])
    .select()
    .single();

  if (error) return res.status(400).json({ error });

  res.json({ user: data });
});

app.get("/users", async (req, res) => {
  const { data, error } = await supabase.from("users").select("*");
  res.json({ data, error });
});

// ---------------------------
// API: PTO request
// ---------------------------
app.post("/pto/request", async (req, res) => {
  const { slack_id, start_date, end_date, category, type, reason } = req.body;

  if (!isValidPto(category, type)) {
    return res.status(400).json({ error: "Invalid PTO category/type" });
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("slack_id", slack_id)
    .single();

  if (userError) return res.status(400).json({ error: userError });

  const days = countBusinessDays(start_date, end_date);
  if (!days) return res.status(400).json({ error: "Invalid dates" });

  // policy
  const { ptoType, error: typeError } = await getPtoType(category, type);
  if (typeError || !ptoType) {
    return res.status(400).json({ error: "Unknown PTO type" });
  }

  // eligibility
  const elig = checkEligibility(user, ptoType);
  if (!elig.ok) {
    return res.status(403).json({ error: elig.reason });
  }

  // balance check (if needed)
  if (!ptoType.is_unlimited && ptoType.counts_against_balance) {
    const { used, error: usedError } = await getUsedDaysForType(user.id, category, type);
    if (usedError) return res.status(400).json({ error: usedError });

    const allowance = ptoType.annual_allowance_days ?? 0;
    const remaining = allowance - used;

    if (days > remaining) {
      return res.status(400).json({
        error: "Request exceeds remaining balance",
        details: {
          requested_days: days,
          remaining_days: remaining,
          allowance_days: allowance,
          used_days: used,
          category,
          type,
        },
      });
    }
  }

  // overlap check
  const { data: overlaps, error: overlapError } = await supabase
    .from("pto_requests")
    .select("id, status, start_date, end_date")
    .eq("user_id", user.id)
    .in("status", ["pending", "approved"])
    .lte("start_date", end_date)
    .gte("end_date", start_date);

  if (overlapError) return res.status(400).json({ error: overlapError });

  if ((overlaps || []).length > 0) {
    return res.status(400).json({
      error: "Request overlaps with an existing PTO request",
      overlaps,
    });
  }

  // insert request
  const { data: request, error: reqError } = await supabase
    .from("pto_requests")
    .insert([
      {
        user_id: user.id,
        start_date,
        end_date,
        days_count: days,
        status: "pending",
        category,
        type,
        reason: reason || null,
        approver_id: user.manager_id,
      },
    ])
    .select()
    .single();

  if (reqError) return res.status(400).json({ error: reqError });

  res.json({
    request,
    computed_days: days,
    manager_id: user.manager_id,
    counts_against_balance: countsAgainstBalance(category, type),
  });
});

// ---------------------------
// API: approve/deny with permissions
// ---------------------------
app.post("/pto/approve", async (req, res) => {
  const { request_id, decided_by_slack_id } = req.body;

  if (!request_id || !decided_by_slack_id) {
    return res.status(400).json({ error: "request_id and decided_by_slack_id are required" });
  }

  const { user: decider, error: deciderError } = await getUserBySlackId(decided_by_slack_id);
  if (deciderError || !decider) return res.status(400).json({ error: "Decider not found" });

  const perm = await canDecideRequest(request_id, decider.id, !!decider.is_admin);
  if (!perm.ok) return res.status(403).json({ error: perm.error });

  const { data, error } = await supabase
    .from("pto_requests")
    .update({
      status: "approved",
      decided_at: new Date().toISOString(),
      decided_by: decider.id,
    })
    .eq("id", request_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error });

  res.json({ approved: data });
});

app.post("/pto/deny", async (req, res) => {
  const { request_id, decided_by_slack_id } = req.body;

  if (!request_id || !decided_by_slack_id) {
    return res.status(400).json({ error: "request_id and decided_by_slack_id are required" });
  }

  const { user: decider, error: deciderError } = await getUserBySlackId(decided_by_slack_id);
  if (deciderError || !decider) return res.status(400).json({ error: "Decider not found" });

  const perm = await canDecideRequest(request_id, decider.id, !!decider.is_admin);
  if (!perm.ok) return res.status(403).json({ error: perm.error });

  const { data, error } = await supabase
    .from("pto_requests")
    .update({
      status: "denied",
      decided_at: new Date().toISOString(),
      decided_by: decider.id,
    })
    .eq("id", request_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error });

  res.json({ denied: data });
});

//PTO CANCEL 
// ---------------------------
// API: cancel own request
// ---------------------------
app.post("/pto/cancel", async (req, res) => {
  const { slack_id, request_id } = req.body;

  if (!request_id || !slack_id) {
    return res.status(400).json({ error: "request_id and slack_id are required" });
  }

  console.log(`🔍 Cancel API: request_id=${request_id}, slack_id=${slack_id}`);

  // Get user
  const { user, error: userError } = await getUserBySlackId(slack_id);
  if (userError || !user) {
    console.error(`❌ Cancel: User not found for slack_id=${slack_id}`);
    return res.status(400).json({ error: "User not found" });
  }

  // Convert request_id to number if it's a string
  const reqId = typeof request_id === "string" ? parseInt(request_id, 10) : request_id;
  if (isNaN(reqId)) {
    return res.status(400).json({ error: "Invalid request_id format" });
  }

  // Get request and verify ownership
  const { data: request, error: reqError } = await supabase
    .from("pto_requests")
    .select("id, user_id, status, start_date")
    .eq("id", reqId)
    .single();

  if (reqError || !request) {
    console.error(`❌ Cancel: Request not found for id=${reqId}`, reqError);
    return res.status(400).json({ error: "Request not found" });
  }

  // Verify ownership
  if (request.user_id !== user.id) {
    console.error(`❌ Cancel: Ownership mismatch. Request user_id=${request.user_id}, current user_id=${user.id}`);
    return res.status(403).json({ error: "You can only cancel your own requests" });
  }

  // Validate status: only pending or approved can be cancelled
  if (request.status !== "pending" && request.status !== "approved") {
    return res.status(400).json({ 
      error: `Cannot cancel request with status: ${request.status}. Only pending or approved requests can be cancelled.` 
    });
  }

  // Optional: Check if start date has passed (you might want to allow cancelling past requests)
  // const today = new Date().toISOString().split('T')[0];
  // if (request.start_date < today && request.status === "approved") {
  //   return res.status(400).json({ error: "Cannot cancel an approved request that has already started" });
  // }

  // Update request to cancelled
  const { data, error } = await supabase
    .from("pto_requests")
    .update({
      status: "cancelled",
      decided_at: new Date().toISOString(),
      decided_by: user.id, // User cancelling their own request
    })
    .eq("id", reqId)
    .select()
    .single();

  if (error) {
    console.error(`❌ Cancel: Database error`, error);
    return res.status(400).json({ error });
  }

  console.log(`✅ Cancel: Request ${reqId} successfully cancelled`);
  res.json({ cancelled: data });
});

// ---------------------------
// API: balance endpoint (JSON)
// ---------------------------
app.get("/pto/balance/:slack_id", async (req, res) => {
  const { slack_id } = req.params;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("slack_id", slack_id)
    .single();

  if (userError) return res.status(400).json({ error: userError });

  const { data: types, error: typesError } = await supabase.from("pto_types").select("*");
  if (typesError) return res.status(400).json({ error: typesError });

  const { data: approved, error: reqError } = await supabase
    .from("pto_requests")
    .select("days_count, category, type")
    .eq("user_id", user.id)
    .eq("status", "approved");

  if (reqError) return res.status(400).json({ error: reqError });

  const usedByType = {};
  for (const r of approved || []) {
    const key = typeKey(r.category, r.type);
    usedByType[key] = (usedByType[key] || 0) + (r.days_count || 0);
  }

  const balances = [];
  for (const t of types) {
    if (t.eligibility_rule === "STUDENTS_ONLY" && !user.is_student) continue;

    const key = typeKey(t.category, t.name);
    const used = usedByType[key] || 0;

    if (t.is_unlimited) {
      balances.push({ category: t.category, type: t.name, unlimited: true, used_days: used });
      continue;
    }

    const allowance = t.annual_allowance_days ?? 0;
    const remaining = t.counts_against_balance ? Math.max(allowance - used, 0) : allowance;

    balances.push({
      category: t.category,
      type: t.name,
      unlimited: false,
      allowance_days: allowance,
      used_days: used,
      remaining_days: remaining,
      counts_against_balance: t.counts_against_balance,
      carryover_allowed: t.carryover_allowed,
    });
  }

  res.json({ user: user.name, is_student: !!user.is_student, balances });
});

// ---------------------------
// API: list requests
// ---------------------------
app.get("/pto/requests", async (req, res) => {
  const { slack_id } = req.query;

  let query = supabase
    .from("pto_requests")
    .select("id, start_date, end_date, days_count, status, category, type, created_at, user_id")
    .order("created_at", { ascending: false });

  if (slack_id) {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id")
      .eq("slack_id", slack_id)
      .single();

    if (userError) return res.status(400).json({ error: userError });
    query = query.eq("user_id", user.id);
  }

  const { data, error } = await query;
  if (error) return res.status(400).json({ error });

  res.json({ data });
});

// ---------------------------
// API: pto types list (for UI)
// ---------------------------
app.get("/pto/types", async (req, res) => {
  const { data, error } = await supabase
    .from("pto_types")
    .select("category, name, eligibility_rule, is_unlimited, annual_allowance_days")
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (error) return res.status(400).json({ error });
  res.json({ data });
});

// ---------------------------
// Admin endpoints
// ---------------------------
app.post("/admin/pto/cancel", async (req, res) => {
  const { admin_slack_id, request_id } = req.body;

  const auth = await requireAdmin(admin_slack_id);
  if (!auth.ok) return res.status(403).json({ error: auth.error });

  const { data, error } = await supabase
    .from("pto_requests")
    .update({
      status: "cancelled",
      decided_at: new Date().toISOString(),
      decided_by: auth.userId,
    })
    .eq("id", request_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error });
  res.json({ cancelled: data });
});

app.post("/admin/pto/type/update", async (req, res) => {
  const { admin_slack_id, category, name, patch } = req.body;

  const auth = await requireAdmin(admin_slack_id);
  if (!auth.ok) return res.status(403).json({ error: auth.error });

  const { data, error } = await supabase
    .from("pto_types")
    .update(patch)
    .eq("category", category)
    .eq("name", name)
    .select()
    .single();

  if (error) return res.status(400).json({ error });
  res.json({ updated: data });
});

app.get("/admin/reports/pto", async (req, res) => {
  const { admin_slack_id } = req.query;

  const auth = await requireAdmin(admin_slack_id);
  if (!auth.ok) return res.status(403).json({ error: auth.error });

  const { data, error } = await supabase
    .from("pto_requests")
    .select(
      "id, start_date, end_date, days_count, status, category, type, created_at, decided_at, approver_id, decided_by, reason, user_id"
    )
    .order("created_at", { ascending: false });

  if (error) return res.status(400).json({ error });
  res.json({ data });
});

// ---------------------------
// Admin: Sync all Slack users to Supabase
// ---------------------------
app.get("/admin/sync-users", async (req, res) => {
  const { admin_slack_id } = req.query;

  if (!admin_slack_id) {
    return res.status(400).json({ error: "admin_slack_id is required" });
  }

  const auth = await requireAdmin(admin_slack_id);
  if (!auth.ok) return res.status(403).json({ error: auth.error });

  try {
    // Get all users from Slack
    const slackUsers = await slack.client.users.list();

    if (!slackUsers.ok) {
      return res.status(500).json({ error: "Failed to fetch Slack users" });
    }

    // Filter out bots and deactivated users
    const realUsers = (slackUsers.members || []).filter(
      (u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT"
    );

    // Get existing users from Supabase
    const { data: existingUsers } = await supabase
      .from("users")
      .select("slack_id");

    const existingSlackIds = new Set((existingUsers || []).map((u) => u.slack_id));

    // Find users that don't exist yet
    const newUsers = realUsers.filter((u) => !existingSlackIds.has(u.id));

    if (newUsers.length === 0) {
      return res.json({
        ok: true,
        message: "All Slack users already exist in database",
        total_slack_users: realUsers.length,
        created: 0,
      });
    }

    // Create new users
    const usersToInsert = newUsers.map((u) => ({
      name: u.real_name || u.name || `User ${u.id}`,
      slack_id: u.id,
      manager_id: null,
      is_admin: false,
      is_student: false,
      country: null,
    }));

    const { data: created, error: insertError } = await supabase
      .from("users")
      .insert(usersToInsert)
      .select();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    console.log(`✅ Synced ${created.length} new users from Slack`);

    res.json({
      ok: true,
      message: `Successfully synced ${created.length} new users`,
      total_slack_users: realUsers.length,
      already_existed: existingSlackIds.size,
      created: created.length,
      new_users: created.map((u) => ({ name: u.name, slack_id: u.slack_id })),
    });
  } catch (e) {
    console.error("Error syncing users:", e);
    res.status(500).json({ error: e.message });
  }
});

// evento app_home_opened
async function publishHome(client, slack_id) {
  try {

    // 1) Auto-register user if needed
    const { user, created, error: userError } = await getOrCreateUser(slack_id, client);

    const blocks = [];

    // Header
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "🏖️ PTO Tool" },
    });

    // If still no user (error creating)
    if (userError || !user) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "❌ Error al cargar tu perfil.\n" +
            "Intenta de nuevo o contacta a un admin.",
        },
      });

      await client.views.publish({
        user_id: slack_id,
        view: { type: "home", blocks },
      });
      return;
    }

    // Welcome banner for newly registered users
    if (created) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `👋 *¡Bienvenido/a, ${user.name}!*\n` +
            `Tu cuenta fue creada automáticamente. Un admin te asignará un manager pronto.`,
        },
      });
      blocks.push({ type: "divider" });
    }

    // Actions: Create OOO (abre modal)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "➕ Create OOO" },
          style: "primary",
          action_id: "home_create_ooo",
        },
      ],
    });

    blocks.push({ type: "divider" });

    // 2) Balance (mini)
    const { data: types } = await supabase
      .from("pto_types")
      .select("*")
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    const { data: approved } = await supabase
      .from("pto_requests")
      .select("days_count, category, type")
      .eq("user_id", user.id)
      .eq("status", "approved");

    const usedBy = {};
    for (const r of approved || []) {
      const key = `${r.category}::${r.type}`;
      usedBy[key] = (usedBy[key] || 0) + (r.days_count || 0);
    }

    const balanceLines = [];
    for (const t of types || []) {
      if (t.eligibility_rule === "STUDENTS_ONLY" && !user.is_student) continue;

      const key = `${t.category}::${t.name}`;
      const used = usedBy[key] || 0;

      if (t.is_unlimited) {
        balanceLines.push(`• *${t.name}*: ∞ (usado: ${used})`);
      } else {
        const allowance = t.annual_allowance_days ?? 0;
        const remaining = t.counts_against_balance ? Math.max(allowance - used, 0) : allowance;
        balanceLines.push(`• *${t.name}*: ${remaining}/${allowance}`);
      }
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*👤 ${user.name}*\n\n*Balance*\n${balanceLines.join("\n")}`,
      },
    });

    blocks.push({ type: "divider" });

    // 3) Tus requests recientes (pending/approved/denied/cancelled)
    const { data: myReqs } = await supabase
      .from("pto_requests")
      .select("id, start_date, end_date, status, category, type, days_count, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5);

    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "📅 Your requests (last 5)" },
    });

    if (!myReqs || myReqs.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No tenés solicitudes todavía._" },
      });
    } else {
      console.log("🔍 DEBUG: Processing", myReqs.length, "requests");
      for (const r of myReqs) {
        // Only show cancel button for pending or approved requests
        const canCancel = r.status === "pending" || r.status === "approved";
        console.log(`🔍 Request ${r.id}: status="${r.status}", canCancel=${canCancel}`);
        
        const sectionBlock = {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `${statusEmoji(r.status)} *${r.type}* (${r.start_date} → ${r.end_date})  —  *${r.days_count}* días\n` +
              `Status: \`${r.status}\``,
          },
        };

        // Add cancel button if applicable
        if (canCancel) {
          console.log(`🔍 ✅ Adding cancel button to request ${r.id}`);
          sectionBlock.accessory = {
            type: "button",
            text: { type: "plain_text", text: "Cancel 🟡" },
            style: "danger",
            action_id: "pto_cancel_btn",
            value: String(r.id),
            confirm: {
              title: { type: "plain_text", text: "Cancel PTO request" },
              text: {
                type: "mrkdwn",
                text: `Are you sure you want to cancel this *${r.type}* request?\n*Dates:* ${r.start_date} → ${r.end_date}\n*Days:* ${r.days_count}`,
              },
              confirm: { type: "plain_text", text: "Yes, cancel" },
              deny: { type: "plain_text", text: "No, keep it" },
            },
          };
        } else {
          console.log(`🔍 ❌ NOT adding cancel button (status: ${r.status})`);
        }

        blocks.push(sectionBlock);
      }
    }

    blocks.push({ type: "divider" });

    // 4) Pending approvals (si sos manager o admin)
    // admin: ve TODAS las requests pendientes
    // manager: requests donde approver_id = user.id
    let pendingQuery = supabase
      .from("pto_requests")
      .select("id, start_date, end_date, status, type, days_count, user_id, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (user.is_admin) {
      // Admin sees ALL pending requests
      pendingQuery = pendingQuery.limit(10);
    } else {
      // Manager only sees their direct reports
      pendingQuery = pendingQuery.eq("approver_id", user.id).limit(5);
    }

    const { data: pendingToApprove } = await pendingQuery;

    if ((pendingToApprove || []).length > 0 || user.is_admin) {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: "✅ Pending approvals" },
      });

      if (!pendingToApprove || pendingToApprove.length === 0) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: "_No tenés approvals pendientes._" },
        });
      } else {
        // traer nombres de requesters
        const requesterIds = [...new Set(pendingToApprove.map((p) => p.user_id))];
        const { data: requesterUsers } = await supabase
          .from("users")
          .select("id, name, slack_id")
          .in("id", requesterIds);

        const mapUser = {};
        for (const u of requesterUsers || []) mapUser[u.id] = u;

        for (const p of pendingToApprove) {
          const ru = mapUser[p.user_id];
          const who = ru?.slack_id ? `<@${ru.slack_id}>` : (ru?.name || "Unknown");

          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `⏳ *${p.type}* (${p.start_date} → ${p.end_date}) — *${p.days_count}* días\n` +
                `Requester: ${who}`,
            },
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Review" },
              action_id: "home_review_request",
              value: p.id,
            },
          });
        }
      }

      blocks.push({ type: "divider" });
    }

    // 5) Admin tools (solo admin)
    if (user.is_admin) {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: "🛠️ Admin tools" },
      });

      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "👥 Manage teams" },
            action_id: "admin_manage_users",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "📥 Add historical PTO" },
            action_id: "admin_add_historical_pto",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "📊 Download reports (coming soon)" },
            action_id: "admin_download_reports",
          },
        ],
      });
    }

    console.log(`🔍 Total blocks before publishing: ${blocks.length}`);
    await client.views.publish({
      user_id: slack_id,
      view: { type: "home", blocks },
    });
    console.log(`✅ Home tab published successfully for user ${slack_id}`);
  } catch (e) {
    console.error("❌ ERROR in publishHome:", e);
    console.error("❌ Error stack:", e.stack);
  }

}
slack.event("app_home_opened", async ({ event, client }) => {
  console.log("🏠 app_home_opened", event.user);
  await publishHome(client, event.user);
});


//"CREATE OOO" abre el mismo modal que /pto request
slack.action("home_create_ooo", async ({ ack, body, client }) => {
  await ack();

  const slack_id = body.user.id;

  // user
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("slack_id", slack_id)
    .single();

  if (userError || !user) return;

  // types
  const { data: types } = await supabase
    .from("pto_types")
    .select("*")
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  const allowedTypes = (types || []).filter(
    (t) => !(t.eligibility_rule === "STUDENTS_ONLY" && !user.is_student)
  );

  const options = allowedTypes.map((t) => ({
    text: { type: "plain_text", text: `${t.name} (${t.category})` },
    value: `${t.category}||${t.name}`,
  }));

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "pto_request_submit",
      title: { type: "plain_text", text: "Request PTO" },
      submit: { type: "plain_text", text: "Send" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "pto_type_block",
          label: { type: "plain_text", text: "OOO Type" },
          element: {
            type: "static_select",
            action_id: "pto_type",
            placeholder: { type: "plain_text", text: "Select type" },
            options,
          },
        },
        {
          type: "input",
          block_id: "start_date_block",
          label: { type: "plain_text", text: "Start date" },
          element: { type: "datepicker", action_id: "start_date" },
        },
        {
          type: "input",
          block_id: "end_date_block",
          label: { type: "plain_text", text: "End date" },
          element: { type: "datepicker", action_id: "end_date" },
        },
        {
          type: "input",
          block_id: "reason_block",
          optional: true,
          label: { type: "plain_text", text: "Reason (optional)" },
          element: { type: "plain_text_input", action_id: "reason", multiline: true },
        },
      ],
    },
  });
});

// review en approvals, abre un modal de reviews simple 
slack.action("home_review_request", async ({ ack, body, client }) => {
  await ack();

  const request_id = body.actions[0].value;

  const { data: req } = await supabase
    .from("pto_requests")
    .select("id, start_date, end_date, status, type, category, days_count, reason, user_id")
    .eq("id", request_id)
    .single();

  if (!req) return;

  const { data: ru } = await supabase
    .from("users")
    .select("name, slack_id")
    .eq("id", req.user_id)
    .single();

  const who = ru?.slack_id ? `<@${ru.slack_id}>` : (ru?.name || "Unknown");

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      title: { type: "plain_text", text: "Review PTO" },
      close: { type: "plain_text", text: "Close" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `*Requester:* ${who}\n` +
              `*Type:* ${req.type}\n` +
              `*Dates:* ${req.start_date} → ${req.end_date}\n` +
              `*Days:* ${req.days_count}\n` +
              `*Status:* ${req.status}\n` +
              (req.reason ? `*Reason:* ${req.reason}\n` : ""),
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve ✅" },
              style: "primary",
              action_id: "pto_approve_btn",
              value: req.id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny ❌" },
              style: "danger",
              action_id: "pto_deny_btn",
              value: req.id,
            },
          ],
        },
      ],
    },
  });
});

// ---------------------------
// Admin: Manage Teams modal
// ---------------------------
slack.action("admin_manage_users", async ({ ack, body, client }) => {
  await ack();

  const slack_id = body.user.id;

  // Run both queries in parallel for speed (Slack has 3s timeout for trigger_id)
  const [adminResult, usersResult] = await Promise.all([
    supabase
      .from("users")
      .select("id, is_admin")
      .eq("slack_id", slack_id)
      .single(),
    supabase
      .from("users")
      .select("id, name, slack_id, manager_id")
      .order("name", { ascending: true }),
  ]);

  const { data: admin, error: adminError } = adminResult;
  const { data: allUsers, error: usersError } = usersResult;

  if (adminError || !admin?.is_admin) {
    return;
  }

  if (usersError || !allUsers || allUsers.length === 0) {
    return;
  }

  // Build options for manager dropdown
  const managerOptions = allUsers.map((u) => ({
    text: { type: "plain_text", text: u.name || `User ${u.slack_id}` },
    value: String(u.id),
  }));

  // Build options for multi-select (users to assign)
  const userOptions = allUsers.map((u) => {
    const currentManager = allUsers.find((m) => m.id === u.manager_id);
    const managerText = currentManager ? ` (→ ${currentManager.name})` : " (no manager)";
    return {
      text: { type: "plain_text", text: `${u.name || u.slack_id}${managerText}` },
      value: String(u.id),
    };
  });

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "admin_assign_team_submit",
      title: { type: "plain_text", text: "Manage Teams" },
      submit: { type: "plain_text", text: "Assign" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Select a manager and choose which users should report to them.",
          },
        },
        {
          type: "input",
          block_id: "manager_block",
          label: { type: "plain_text", text: "Manager" },
          element: {
            type: "static_select",
            action_id: "manager_select",
            placeholder: { type: "plain_text", text: "Select manager" },
            options: managerOptions,
          },
        },
        {
          type: "input",
          block_id: "users_block",
          label: { type: "plain_text", text: "Assign these users to the manager" },
          element: {
            type: "multi_static_select",
            action_id: "users_select",
            placeholder: { type: "plain_text", text: "Select users" },
            options: userOptions,
          },
        },
      ],
    },
  });
});

// Handle assign team submit
slack.view("admin_assign_team_submit", async ({ ack, body, view, client }) => {
  await ack();

  const slack_id = body.user.id;

  // Verify admin
  const { data: admin, error: adminError } = await supabase
    .from("users")
    .select("id, is_admin")
    .eq("slack_id", slack_id)
    .single();

  if (adminError || !admin?.is_admin) {
    return;
  }

  // Get selected values
  const managerId = view.state.values.manager_block.manager_select.selected_option.value;
  const selectedUsers = view.state.values.users_block.users_select.selected_options || [];
  const userIds = selectedUsers.map((o) => o.value);

  if (userIds.length === 0) {
    return;
  }

  // Update all selected users to have this manager
  const { error: updateError } = await supabase
    .from("users")
    .update({ manager_id: parseInt(managerId, 10) })
    .in("id", userIds.map((id) => parseInt(id, 10)));

  if (updateError) {
    console.error("Error updating manager assignments:", updateError);
    return;
  }

  // Get manager name for confirmation
  const { data: manager } = await supabase
    .from("users")
    .select("name, slack_id")
    .eq("id", managerId)
    .single();

  const managerMention = manager?.slack_id ? `<@${manager.slack_id}>` : manager?.name || "Unknown";

  // Send confirmation DM
  const dm = await client.conversations.open({ users: slack_id });
  await client.chat.postMessage({
    channel: dm.channel.id,
    text: `✅ Updated ${userIds.length} user(s) to report to ${managerMention}`,
  });

  // Refresh home
  await publishHome(client, slack_id);
});

// ---------------------------
// Admin: Add Historical PTO modal
// ---------------------------
slack.action("admin_add_historical_pto", async ({ ack, body, client }) => {
  await ack();

  const slack_id = body.user.id;

  // Run queries in parallel
  const [adminResult, usersResult, typesResult] = await Promise.all([
    supabase
      .from("users")
      .select("id, is_admin")
      .eq("slack_id", slack_id)
      .single(),
    supabase
      .from("users")
      .select("id, name, slack_id")
      .order("name", { ascending: true }),
    supabase
      .from("pto_types")
      .select("category, name")
      .order("category", { ascending: true })
      .order("name", { ascending: true }),
  ]);

  const { data: admin, error: adminError } = adminResult;
  const { data: allUsers, error: usersError } = usersResult;
  const { data: ptoTypes, error: typesError } = typesResult;

  if (adminError || !admin?.is_admin) {
    return;
  }

  if (usersError || !allUsers || allUsers.length === 0) {
    return;
  }

  // Build user options
  const userOptions = allUsers.map((u) => ({
    text: { type: "plain_text", text: u.name || `User ${u.slack_id}` },
    value: String(u.id),
  }));

  // Build PTO type options
  const typeOptions = (ptoTypes || []).map((t) => ({
    text: { type: "plain_text", text: `${t.name} (${t.category})` },
    value: `${t.category}||${t.name}`,
  }));

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "admin_historical_pto_submit",
      title: { type: "plain_text", text: "Add Historical PTO" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "📥 *Add a historical PTO record*\n\nThis will be saved as `approved` automatically and will count against the user's balance.",
          },
        },
        {
          type: "input",
          block_id: "user_block",
          label: { type: "plain_text", text: "Employee" },
          element: {
            type: "static_select",
            action_id: "user_select",
            placeholder: { type: "plain_text", text: "Select employee" },
            options: userOptions,
          },
        },
        {
          type: "input",
          block_id: "type_block",
          label: { type: "plain_text", text: "PTO Type" },
          element: {
            type: "static_select",
            action_id: "type_select",
            placeholder: { type: "plain_text", text: "Select type" },
            options: typeOptions,
          },
        },
        {
          type: "input",
          block_id: "start_date_block",
          label: { type: "plain_text", text: "Start date" },
          element: { type: "datepicker", action_id: "start_date" },
        },
        {
          type: "input",
          block_id: "end_date_block",
          label: { type: "plain_text", text: "End date" },
          element: { type: "datepicker", action_id: "end_date" },
        },
        {
          type: "input",
          block_id: "note_block",
          optional: true,
          label: { type: "plain_text", text: "Note (optional)" },
          element: {
            type: "plain_text_input",
            action_id: "note",
            placeholder: { type: "plain_text", text: "e.g., Migrated from old system" },
          },
        },
      ],
    },
  });
});

// Handle historical PTO submit
slack.view("admin_historical_pto_submit", async ({ ack, body, view, client }) => {
  const slack_id = body.user.id;

  // Verify admin
  const { data: admin, error: adminError } = await supabase
    .from("users")
    .select("id, is_admin")
    .eq("slack_id", slack_id)
    .single();

  if (adminError || !admin?.is_admin) {
    await ack({ response_action: "errors", errors: { user_block: "Not authorized" } });
    return;
  }

  // Get form values
  const userId = view.state.values.user_block.user_select.selected_option.value;
  const typeValue = view.state.values.type_block.type_select.selected_option.value;
  const [category, type] = typeValue.split("||");
  const start_date = view.state.values.start_date_block.start_date.selected_date;
  const end_date = view.state.values.end_date_block.end_date.selected_date;
  const note = view.state.values.note_block?.note?.value || "Historical record";

  // Validate dates
  if (end_date < start_date) {
    await ack({
      response_action: "errors",
      errors: { end_date_block: "End date must be after start date" },
    });
    return;
  }

  // Calculate business days
  const days = countBusinessDays(start_date, end_date);
  if (!days) {
    await ack({
      response_action: "errors",
      errors: { end_date_block: "Invalid dates" },
    });
    return;
  }

  // Create the PTO request as approved
  const { data: newPto, error: createError } = await supabase
    .from("pto_requests")
    .insert([
      {
        user_id: parseInt(userId, 10),
        start_date,
        end_date,
        days_count: days,
        status: "approved",
        category,
        type,
        reason: note,
        approver_id: admin.id,
        decided_by: admin.id,
        decided_at: new Date().toISOString(),
      },
    ])
    .select()
    .single();

  if (createError) {
    console.error("Error creating historical PTO:", createError);
    await ack({
      response_action: "errors",
      errors: { user_block: "Error saving record. Try again." },
    });
    return;
  }

  await ack();

  // Get user name for confirmation
  const { data: targetUser } = await supabase
    .from("users")
    .select("name, slack_id")
    .eq("id", userId)
    .single();

  const userMention = targetUser?.slack_id ? `<@${targetUser.slack_id}>` : targetUser?.name || "Unknown";

  // Send confirmation DM to admin
  const dm = await client.conversations.open({ users: slack_id });
  await client.chat.postMessage({
    channel: dm.channel.id,
    text:
      `✅ *Historical PTO saved*\n\n` +
      `• Employee: ${userMention}\n` +
      `• Type: ${type}\n` +
      `• Dates: ${start_date} → ${end_date}\n` +
      `• Days: ${days}\n` +
      `• Note: ${note}`,
  });

  // Refresh home
  await publishHome(client, slack_id);
});

// ---------------------------
// Cron: Daily PTO notifications
// Call this endpoint daily (e.g., via Railway cron or external scheduler)
// ---------------------------
app.get("/cron/pto-notifications", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const results = { started: [], ended: [] };

    // 1) Find approved PTOs that START today
    const { data: startingToday, error: startError } = await supabase
      .from("pto_requests")
      .select("id, user_id, type, start_date, end_date, days_count")
      .eq("status", "approved")
      .eq("start_date", today);

    if (startError) {
      console.error("Error fetching starting PTOs:", startError);
    }

    // 2) Find approved PTOs that END today
    const { data: endingToday, error: endError } = await supabase
      .from("pto_requests")
      .select("id, user_id, type, start_date, end_date")
      .eq("status", "approved")
      .eq("end_date", today);

    if (endError) {
      console.error("Error fetching ending PTOs:", endError);
    }

    // Get all user IDs we need
    const userIds = [
      ...new Set([
        ...(startingToday || []).map((p) => p.user_id),
        ...(endingToday || []).map((p) => p.user_id),
      ]),
    ];

    if (userIds.length === 0) {
      return res.json({ ok: true, message: "No PTOs starting or ending today", results });
    }

    // Fetch users
    const { data: users } = await supabase
      .from("users")
      .select("id, name, slack_id")
      .in("id", userIds);

    const userMap = {};
    for (const u of users || []) userMap[u.id] = u;

    // 3) Process PTOs starting today
    for (const pto of startingToday || []) {
      const user = userMap[pto.user_id];
      if (!user?.slack_id) continue;

      const startFormatted = pto.start_date;
      const endFormatted = pto.end_date;

      // DM to user
      try {
        const dm = await slack.client.conversations.open({ users: user.slack_id });
        await slack.client.chat.postMessage({
          channel: dm.channel.id,
          text:
            `🌴 *Your OOO starts today!*\n\n` +
            `• Type: *${pto.type}*\n` +
            `• Dates: *${startFormatted} → ${endFormatted}*\n` +
            `• Days: *${pto.days_count}*\n\n` +
            `💡 Remember to update your Slack status to:\n` +
            `\`🌴 OOO ${startFormatted} - ${endFormatted}\``,
        });
      } catch (e) {
        console.error(`Error sending DM to ${user.slack_id}:`, e.message);
      }

      // Post in #team-pto channel
      try {
        await slack.client.chat.postMessage({
          channel: PTO_CHANNEL_ID,
          text: `🌴 <@${user.slack_id}> is OOO today (${pto.type}) — ${startFormatted} → ${endFormatted}`,
        });
      } catch (e) {
        console.error(`Error posting to channel:`, e.message);
      }

      results.started.push({ user: user.name, type: pto.type });
    }

    // 4) Process PTOs ending today
    for (const pto of endingToday || []) {
      const user = userMap[pto.user_id];
      if (!user?.slack_id) continue;

      // DM to user
      try {
        const dm = await slack.client.conversations.open({ users: user.slack_id });
        await slack.client.chat.postMessage({
          channel: dm.channel.id,
          text:
            `👋 *Welcome back!* Your OOO (${pto.type}) ends today.\n\n` +
            `💡 Remember to clear your Slack status if you set one.`,
        });
      } catch (e) {
        console.error(`Error sending DM to ${user.slack_id}:`, e.message);
      }

      results.ended.push({ user: user.name, type: pto.type });
    }

    console.log(`✅ Cron completed: ${results.started.length} started, ${results.ended.length} ended`);
    res.json({ ok: true, results });
  } catch (e) {
    console.error("Cron error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------
// test-db (debug)
// ---------------------------
app.get("/test-db", async (req, res) => {
  const { data, error } = await supabase.from("users").select("*");
  res.json({ data, error });
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
});
