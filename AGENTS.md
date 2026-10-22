# Vault - Finanzas Personales Inteligentes

**Vault** es una plataforma premium de gestión de finanzas personales diseñada con un enfoque de alto nivel visual (Obsidian Dark) e impulsada por Inteligencia Artificial. Permite consolidar cuentas multimoneda, registrar movimientos financieros con comprobantes adjuntos e importar extractos bancarios en texto o archivos de manera estructurada gracias a un flujo inteligente con Gemini.

---

## 🚀 Arquitectura Tecnológica

El proyecto está estructurado como un monorepo administrado con **pnpm Workspaces**, garantizando consistencia en dependencias y modularidad entre el frontend y el backend.

```
vault-personal-finances (Raíz)
├── apps/views/components (src/)  # Frontend Vue 3 + Vite
├── functions/                    # Backend Firebase Cloud Functions v2 + Genkit
├── firestore.rules               # Reglas de seguridad de base de datos
├── storage.rules                 # Reglas de seguridad de almacenamiento de archivos
└── pnpm-workspace.yaml           # Configuración del monorepo
```

### Stack de Tecnologías

* **Frontend:**
  * **Vue 3 (`<script setup lang="ts">`):** Framework base para la reactividad y modularidad.
  * **Vite + Tailwind CSS v4:** Compilación rápida y sistema de estilos premium de cristal (glassmorphism) con variables de color HSL fluidas.
  * **TypeScript:** Tipado estático estricto en toda la aplicación.
  * **Pinia:** Manejo del estado global (Stores de Auth, Accounts, Transactions, Goals y Settings).
  * **Zod:** Validación robusta de formularios y esquemas de datos en tiempo de ejecución.
  * **Chart.js:** Gráficos dinámicos e interactivos de flujo mensual y distribución por categorías.
  * **Lucide Vue Next:** Librería de iconos vectoriales consistentes.

* **Backend & Infraestructura (Firebase):**
  * **Firebase Auth:** Autenticación y resguardo seguro de credenciales de usuario.
  * **Cloud Firestore:** Base de datos documental NoSQL para almacenar perfiles, cuentas, transacciones y configuraciones.
  * **Firebase Storage:** Almacenamiento en la nube de comprobantes financieros y extractos bancarios.
  * **Cloud Functions v2:** Endpoints HTTPS seguros escritos en TypeScript.
  * **Genkit:** Integración con modelos de lenguaje de Google (Gemini) estructurando las respuestas mediante esquemas Zod en el backend.

---

## 🌟 Características Principales

### 1. Panel de Control Interactivo (Dashboard)
Visualización en tiempo real del patrimonio neto (consolidado en la moneda principal del usuario), ingresos del mes, egresos y tasa de ahorro. Incluye gráficos interactivos (donas para gastos por categoría, barras para ingresos vs. egresos mensuales) y un listado de los movimientos más recientes.

### 2. Gestión de Cuentas Multimoneda
Permite registrar y eliminar cuentas corrientes, de ahorros, efectivo y tarjetas de crédito. Cada cuenta maneja su propia divisa (COP, USD, EUR, etc.), calculando el saldo disponible y aplicando límites de cupo para tarjetas de crédito de manera dinámica.

### 3. Registro Detallado de Movimientos (Ingresos, Gastos y Transferencias)
Registro manual de transacciones. Soporta:
* Clasificación en categorías con iconos dinámicos.
* Flujo de **Transferencias Internas** entre cuentas del usuario, actualizando los saldos correspondientes (resta en origen, suma en destino) de manera atómica.
* **Subida de Comprobantes:** Los usuarios pueden adjuntar una foto o archivo PDF del recibo, el cual se carga de forma reactiva a Firebase Storage. Al borrar un movimiento, el sistema limpia automáticamente el archivo de Storage para evitar la acumulación de archivos huérfanos.

### 4. Importador de Extractos Bancarios con IA
Permite subir archivos de texto (`.txt`, `.csv`) o pegar fragmentos de texto de notificaciones bancarias.
* **Toggable & Opcional:** El importador se puede activar o desactivar desde la configuración.
* **API Key Personalizable:** El usuario puede usar la API Key por defecto del proyecto o configurar su propia API Key de Gemini. 
* **Encriptación de Extremo a Extremo:** Para seguridad del usuario, su clave personal de Gemini no se guarda en LocalStorage. Se encripta simétricamente (AES-256-CBC) en una Cloud Function del servidor utilizando una clave secreta del proyecto y se guarda en un documento seguro de Firestore. Durante el parsing de extractos, la Cloud Function recupera la clave, la desencripta y realiza la consulta a Gemini sin exponerla en los logs ni en la consola del cliente.
* **Pantalla de Revisión Interactiva:** Antes de guardar, los movimientos parsed se cargan en una tabla interactiva donde el usuario puede modificar montos, descripciones, reclasificar categorías o desmarcar transacciones específicas antes de guardarlas masivamente.

### 5. Presupuestos y Objetivos de Ahorro
Permite establecer metas financieras personalizadas (ej. ahorrar para un carro o un viaje) y asignar fondos de manera atómica descontándolos de cuentas bancarias reales. Incluye un planificador de presupuestos interactivo basado en la regla 50/30/20, soportado por gráficos de distribución en tiempo real con Chart.js.

### 6. Asesor Financiero IA (Modo Agente Chatbot)
Un chatbot integrado e interactivo (pestaña "Asesor IA") impulsado por Genkit y Gemini 2.5 Flash (`gemini-2.5-flash`).
* **Acceso a la Base de Datos:** A través de Genkit Tools seguras, el Agente puede consultar, crear y modificar cuentas, transacciones y objetivos de ahorro en tiempo real a nombre del usuario.
* **Búsqueda Semántica Vectorial:** Integra el modelo `gemini-embedding-2` (vectores en la colección server-only `transactionEmbeddings`, sincronizados por un trigger) para buscar transacciones mediante lenguaje natural (ej. "¿cuánto gasté en ropa el mes pasado?"), calculando similitud coseno en memoria de la Cloud Function.
* **Contextualización Tributaria y Regional:** Lee el país y moneda configurados por el usuario para adaptar su vocabulario y aplicar reglas impositivas locales de manera dinámica (ej. impuesto de 4x1000/DIAN en Colombia, SAT/ISR en México, IRPF/Modelo 100 en España, IRS/401(k) en EE.UU., etc.). Permite la configuración regional en la pantalla de Ajustes.

---

## 🔒 Reglas de Seguridad y Criptografía

### Firestore Rules
Las reglas prohíben accesos no autorizados. Cada usuario solo puede leer y modificar sus propios documentos en `/users/{userId}`, `/accounts`, `/transactions`, `/goals` y `/categories`. Las categorías globales (`userId == null`) son de solo lectura pública.

### Storage Rules
Los usuarios solo pueden leer y escribir archivos en su subcarpeta dedicada: `/users/{userId}/*`.

---

## 🛠️ Ejecución Local y Emulación

Vault está diseñado para correr completamente offline utilizando **Firebase Emulator Suite** y **Genkit Developer UI**.

### Requisitos Previos
* Node.js v20+
* pnpm v11+
* Java (requerido para los emuladores de Firebase)

### Instrucciones de Instalación y Arranque

1. **Instalar Dependencias:**
   ```bash
   pnpm install
   ```

2. **Configurar Entorno:**
   Crea el archivo `functions/.env` con tu clave de desarrollo de Gemini y la frase secreta de encriptación:
   ```env
   GEMINI_API_KEY=tu-api-key-de-google-ai-studio
   ENCRYPTION_SECRET=vault-super-secure-encryption-secret-32-chars
   ```

   **Alertas de presupuesto por correo (opcional):** el trigger `notifyBudgetThreshold` envía un correo a los miembros del workspace cuando una categoría llega al 80 % o al 100 % de su tope, o cuando lo hace el tope total del presupuesto (el `totalLimit` de los presupuestos creados) o cuando el gasto de un presupuesto llega al 80 % o al 100 % de sus fondos (los ingresos asignados a ese presupuesto), o cuando el gasto total del mes llega al 80 % o al 100 % de los ingresos del mes (el mayor entre el ingreso del planificador 50/30/20 y los ingresos registrados en el mes sin presupuesto asignado; los gastos de presupuestos con fondos propios no cuentan), usando `nodemailer` sobre Gmail SMTP. Requiere una cuenta de Gmail con verificación en dos pasos y una **contraseña de aplicación** (https://myaccount.google.com/apppasswords); la contraseña normal de la cuenta no funciona.
   * **Local (emuladores):** crea `functions/.secret.local` (no se versiona) con:
     ```env
     SMTP_USER=tu-cuenta@gmail.com
     SMTP_PASS=tu-app-password-de-16-caracteres
     ```
     Son secretos de Functions (`defineSecret`), por eso van en `.secret.local` y no en `functions/.env`. Si faltan, la función registra una advertencia y no envía el correo.
   * **Producción:** `firebase functions:secrets:set SMTP_USER` y `firebase functions:secrets:set SMTP_PASS` antes de desplegar.
   * Opcional: `ALERTS_FROM="Vault <tu-cuenta@gmail.com>"` en `functions/.env` para personalizar el remitente (por defecto `Vault <SMTP_USER>`; Gmail solo permite tu cuenta o sus alias).
   * Las alertas se activan o desactivan por workspace en **Configuración → Workspace** (campo `budgetAlertsEnabled`, activo por defecto).

   **Alertas de presupuesto por notificación push (opcional):** el mismo trigger envía también una notificación web push (Firebase Cloud Messaging) a cada dispositivo que la haya activado. El correo se envía primero; si la push falla, el correo no se ve afectado, y los tokens inválidos se eliminan automáticamente. Si no hay SMTP configurado pero hay dispositivos registrados, se envía solo la push.
   * **Clave VAPID:** en Firebase Console → Configuración del proyecto → Cloud Messaging → Certificados de push web, genera un par de claves y agrega la clave pública al `.env` del frontend como `VITE_FIREBASE_VAPID_KEY=...`. Sin ella, el interruptor aparece deshabilitado.
   * **Activación por dispositivo:** en **Configuración**, interruptor "Notificaciones push en este dispositivo". El token se guarda en `users/{uid}/pushTokens/{token}` (solo el dueño puede leerlo o borrarlo).
   * **iPhone/iPad:** solo recibe push si Vault se instala con *Compartir → Agregar a pantalla de inicio* y la activación se hace desde la app instalada.
   * Opcional: `APP_URL=https://tu-dominio` en `functions/.env` para que el clic en la notificación use un enlace absoluto; sin ella, el service worker abre `/goals`.
   * El service worker (`public/firebase-messaging-sw.js`) debe servirse por HTTPS (o `localhost`). FCM no tiene emulador: la push solo se puede probar contra el proyecto real.

3. **Iniciar Servidores:**
   * **Frontend (Vite):** `pnpm dev`
   * **Firebase Emulators (Auth, Firestore, Storage, Functions):** `pnpm emulators` (consola en `http://localhost:4000`)
   * **Genkit Developer UI:** `pnpm genkit` (playground en `http://localhost:4001`)
