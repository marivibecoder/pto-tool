# 🏖️ PTO Tool – MVP (Slack-first)

Tool interna para gestionar PTO (vacations, sick leave, study, etc.) con aprobación por manager y uso principal desde Slack.

MVP simple pero **bien hecho**: policy clara, balances por tipo, validaciones y approvals con permisos.

---

## 🧠 Estado actual (qué ya funciona)

- Backend en Node + Express  
- Base de datos en Supabase  
- Lógica completa de:
  - tipos de PTO (policy)
  - balances por tipo
  - validaciones (no exceder balance, eligibility)
  - approvals con permisos (manager o admin)
- Integración con Slack:
  - slash command `/pto`
  - comando `/pto balance` funcionando
- ngrok configurado para desarrollo local

---

## 🧱 Stack

- Node.js (ES Modules)
- Express
- Supabase (DB)
- Slack Bolt
- ngrok (solo dev)

---

## Deployment

- Esto se encuentra deployado en Railway: https://railway.com/project/4a55ebf7-e5c3-49db-9832-92ec00bda625?


## ▶️ Cómo levantar el proyecto

### 1️⃣ Levantar backend

```
node src/index.js
```

Server:
```
http://localhost:3000
```

Healthcheck:
```
GET /health
```

---

### 2️⃣ Levantar ngrok (otra terminal)

> No tenes ngrok? Descargalo [aca](https://ngrok.com/download/mac-os?tab=download)

```
./ngrok http 3000
```

Usar la URL:
```
https://xxxx.ngrok-free.dev
```

---

### 3️⃣ Slack App

- Slash Command `/pto`
  ```
  https://TU_NGROK/slack/events
  ```

- Interactivity & Shortcuts
  ```
  https://TU_NGROK/slack/events
  ```

Variables `.env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

---

## 💬 Comandos de Slack

### `/pto`
Ayuda básica.

### `/pto balance`
Muestra balances:
- Vacation
- Study (solo students)
- Sick / Medical (unlimited)

---

## 🗂️ Modelo de datos

### Users
- slack_id
- manager_id
- is_admin
- is_student

### PTO Types
- name
- allowance / unlimited
- eligibility
- counts_against_balance

### PTO Requests
- user_id
- category / type
- start_date / end_date
- days_count
- status
- approver_id
- decided_by / decided_at
- reason

---

## 🔐 Reglas implementadas

- Approval solo por manager o admin
- No descuento hasta aprobar
- No exceder balance
- Sin fines de semana
- Sin solapamientos
- Study solo para students

---

## 🚧 Próximos pasos

1. `/pto request` modal
2. Approval con botones
3. UX polish
4. Admin UI

---

## 🧭 Retomar trabajo

1. `node src/index.js`
2. `./ngrok http 3000`
3. Usar Slack

Lo difícil ya está hecho.
