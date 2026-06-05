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
  * **Pinia:** Manejo del estado global (Stores de Auth, Accounts, Transactions y Settings).
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

---

## 🔒 Reglas de Seguridad y Criptografía

### Firestore Rules
Las reglas prohíben accesos no autorizados. Cada usuario solo puede leer y modificar sus propios documentos en `/users/{userId}`, `/accounts`, `/transactions`, y `/categories`. Las categorías globales (`userId == null`) son de solo lectura pública.

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

3. **Iniciar Servidores:**
   * **Frontend (Vite):** `pnpm dev`
   * **Firebase Emulators (Auth, Firestore, Storage, Functions):** `pnpm emulators` (consola en `http://localhost:4000`)
   * **Genkit Developer UI:** `pnpm genkit` (playground en `http://localhost:4001`)
