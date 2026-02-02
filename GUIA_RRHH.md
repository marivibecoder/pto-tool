# 🏖️ PTO Tool - Guía para Recursos Humanos

## ¿Qué es PTO Tool?

PTO Tool es una herramienta para gestionar solicitudes de tiempo libre (vacaciones, licencias, etc.) directamente desde Slack. Los empleados solicitan PTO, los managers aprueban, y RRHH tiene control total sobre la configuración.

---

## 🚀 Primeros Pasos

### Acceder a la herramienta
1. Abre **Slack**
2. Busca la app **pto-tool** en la barra lateral izquierda
3. Click en la pestaña **Home** para ver el panel principal

---

## 👔 Funciones de Admin (RRHH)

Como admin, tienes acceso a herramientas especiales en el **Home tab**:

### 1. Gestionar Equipos (Manage Teams)

Permite asignar qué empleados reportan a qué manager.

**Cómo usar:**
1. En el Home tab, click en **"👥 Manage teams"**
2. Selecciona un **Manager** del dropdown
3. Selecciona los **empleados** que reportan a ese manager (puedes seleccionar varios)
4. Click **"Assign"**

> 💡 **Tip:** Puedes asignar todo un equipo a un manager de una sola vez.

---

### 2. Cargar PTOs Históricos (Add Historical PTO)

Útil para migrar datos del sistema anterior. Permite registrar vacaciones ya tomadas.

**Cómo usar:**
1. En el Home tab, click en **"📥 Add historical PTO"**
2. Selecciona el **empleado**
3. Selecciona el **tipo de PTO** (Vacation, Sick, etc.)
4. Ingresa las **fechas** de inicio y fin
5. Opcionalmente agrega una **nota** (ej: "Migrado del sistema anterior")
6. Click **"Save"**

> ⚠️ **Importante:** Estos registros se guardan como "aprobados" y descuentan del balance del empleado.

---

### 3. Aprobar Solicitudes Pendientes

Como admin, puedes ver y aprobar **TODAS** las solicitudes pendientes, no solo las de tu equipo.

**Cómo aprobar:**
1. En el Home tab, ve a la sección **"✅ Pending approvals"**
2. Click en **"Review"** junto a la solicitud
3. Revisa los detalles y click en **"Approve ✅"** o **"Deny ❌"**

> 💡 **Útil cuando:** Un manager está de vacaciones y hay solicitudes pendientes de su equipo.

---

### 4. Comandos de Admin

Además de los botones, tienes comandos de texto disponibles:

| Comando | Descripción |
|---------|-------------|
| `/pto admin team @manager` | Ver quiénes reportan a un manager |
| `/pto admin assign-manager @user @manager` | Asignar manager a un usuario |
| `/pto admin set-admin @user true` | Dar permisos de admin a alguien |
| `/pto admin set-admin @user false` | Quitar permisos de admin |

---

## 👤 Gestión de Usuarios

### Usuarios nuevos

Los usuarios se registran **automáticamente** la primera vez que usan la herramienta. Solo necesitas:
1. Esperar a que el empleado use `/pto` o abra el Home tab
2. Asignarle un manager usando "Manage teams"

### Importar todos los usuarios de Slack

Si necesitas cargar todos los usuarios de una vez:
1. Abre en tu navegador: `https://pto-tool-production.up.railway.app/admin/sync-users?admin_slack_id=TU_SLACK_ID`
2. Esto importará todos los usuarios del workspace de Slack
3. Luego asígnales managers usando "Manage teams"

> 📝 Reemplaza `TU_SLACK_ID` con tu ID de Slack (lo encuentras en tu perfil → "..." → "Copy member ID")

---

## 📢 Notificaciones Automáticas

La herramienta envía notificaciones automáticas:

| Evento | Notificación |
|--------|--------------|
| OOO comienza hoy | DM al empleado recordando actualizar su status de Slack |
| OOO termina hoy | DM al empleado recordando limpiar su status |
| Alguien está OOO | Post en canal **#team-pto** anunciando quién está fuera |

---

## 📋 Tipos de PTO Disponibles

| Tipo | Días | Notas |
|------|------|-------|
| Vacation | 25/año | Descuenta del balance |
| Sick Leave | Ilimitado | No descuenta |
| Medical Leave | Ilimitado | Licencia médica extendida |
| Parental Leave | Según policy | Licencia parental |
| Study | 5/año | Solo para estudiantes |
| Marriage | 10 días | Licencia por casamiento |
| Relocation | 1 día | Mudanza |
| Conference | Según evento | Asistencia a conferencias |

---

## ❓ Preguntas Frecuentes

**¿Qué pasa si un manager no está disponible para aprobar?**
> Como admin, puedes aprobar cualquier solicitud pendiente desde tu Home tab.

**¿Puedo modificar una solicitud ya enviada?**
> No directamente. El empleado debe cancelarla y crear una nueva.

**¿Se descuentan fines de semana?**
> No, solo se cuentan días hábiles (lunes a viernes).

**¿Cómo veo el historial de PTOs de un empleado?**
> Actualmente se ve en Supabase. Próximamente habrá reportes descargables.

**¿Cómo agrego un nuevo tipo de PTO?**
> Se debe agregar directamente en Supabase, en la tabla `pto_types`.

---

## 🆘 Soporte

Si tienes problemas técnicos con la herramienta, contacta al equipo de desarrollo.

---

*Última actualización: Febrero 2026*
