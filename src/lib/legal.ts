// Terms of use and data-processing policy (Ley 1581 de 2012). Bump a version
// whenever its document changes substantially: profiles record the versions
// each user accepted.

export const LEGAL_VERSIONS = {
  terms: '2026-10-29',
  privacy: '2026-10-29'
} as const

export interface DataController {
  name: string
  id: string
  address: string
  email: string
}

// Placeholders until the data controller's identity is provided. The legal
// pages show a draft banner while any of them remains.
export const DATA_CONTROLLER: DataController = {
  name: '[NOMBRE O RAZÓN SOCIAL DEL RESPONSABLE]',
  id: '[NIT O CÉDULA]',
  address: '[DIRECCIÓN Y CIUDAD]',
  email: '[CORREO DE ATENCIÓN DE DATOS PERSONALES]'
}

export function hasPendingPlaceholders(controller: DataController = DATA_CONTROLLER): boolean {
  return Object.values(controller).some((value) => /\[[^\]]+\]/.test(value))
}

export type ConsentMethod = 'signup-checkbox' | 'google-continue'

export function buildLegalConsent<T>(method: ConsentMethod, acceptedAt: T) {
  return {
    termsVersion: LEGAL_VERSIONS.terms,
    privacyVersion: LEGAL_VERSIONS.privacy,
    method,
    acceptedAt
  }
}

export interface LegalSection {
  heading: string
  paragraphs: string[]
}

export interface LegalDocument {
  title: string
  version: string
  effectiveLabel: string
  sections: LegalSection[]
}

export type LegalDocumentId = 'terms' | 'privacy'

const c = DATA_CONTROLLER

const terms: LegalDocument = {
  title: 'Términos y condiciones',
  version: LEGAL_VERSIONS.terms,
  effectiveLabel: '29 de octubre de 2026',
  sections: [
    {
      heading: 'Aceptación',
      paragraphs: ['Al crear una cuenta o usar Vault aceptas estos términos. Si no estás de acuerdo, no uses el servicio.']
    },
    {
      heading: 'El servicio',
      paragraphs: [
        'Vault es una herramienta para registrar y organizar finanzas personales y compartidas: cuentas, bolsillos, tarjetas, movimientos, presupuestos y metas.',
        'Vault no es una entidad financiera: no custodia dinero ni ejecuta pagos o transferencias.'
      ]
    },
    {
      heading: 'Tu cuenta',
      paragraphs: [
        'Debes ser mayor de 18 años. Eres responsable de la información que registras y de mantener segura tu contraseña.',
        'Cuando invitas a otras personas a un espacio de trabajo, ellas pueden ver y modificar la información de ese espacio.'
      ]
    },
    {
      heading: 'Inteligencia artificial',
      paragraphs: [
        'El importador de extractos y el asistente usan modelos de inteligencia artificial que pueden cometer errores. Revisa los movimientos importados antes de guardarlos.',
        'La información que entrega el asistente es orientativa y no constituye asesoría financiera, tributaria ni legal.'
      ]
    },
    {
      heading: 'Uso aceptable',
      paragraphs: ['No uses Vault para actividades ilegales, para intentar acceder a cuentas o espacios de otras personas, ni para afectar el funcionamiento del servicio.']
    },
    {
      heading: 'Disponibilidad y precio',
      paragraphs: [
        'Durante la etapa de prueba (beta), Vault se ofrece sin costo y puede cambiar, presentar fallas o interrumpirse.',
        'Si en el futuro hay planes pagos, te informaremos las condiciones antes de cobrarte cualquier valor.'
      ]
    },
    {
      heading: 'Responsabilidad',
      paragraphs: ['Vault se ofrece tal como está. En la medida permitida por la ley, no respondemos por decisiones financieras tomadas con base en la información de la aplicación, ni por pérdidas derivadas de errores en los datos registrados o importados.']
    },
    {
      heading: 'Terminación',
      paragraphs: ['Puedes dejar de usar Vault en cualquier momento y solicitar la eliminación de tu cuenta. Podemos suspender cuentas que incumplan estos términos.']
    },
    {
      heading: 'Cambios',
      paragraphs: ['Podemos actualizar estos términos. Te avisaremos los cambios sustanciales antes de que entren en vigor.']
    },
    {
      heading: 'Ley aplicable y contacto',
      paragraphs: [`Estos términos se rigen por las leyes de la República de Colombia. Para cualquier inquietud escribe a ${c.email}.`]
    }
  ]
}

const privacy: LegalDocument = {
  title: 'Política de tratamiento de datos personales',
  version: LEGAL_VERSIONS.privacy,
  effectiveLabel: '29 de octubre de 2026',
  sections: [
    {
      heading: 'Responsable del tratamiento',
      paragraphs: [
        `${c.name}, identificado con ${c.id}, con domicilio en ${c.address}. Correo de contacto: ${c.email}.`,
        'Esta política se adopta en cumplimiento de la Ley 1581 de 2012 y del Decreto 1074 de 2015, que compila el Decreto 1377 de 2013.'
      ]
    },
    {
      heading: 'Datos que tratamos',
      paragraphs: [
        'Datos de identificación y contacto: nombre y correo electrónico, incluidos los que entrega Google si ingresas con tu cuenta de Google.',
        'Información financiera que registras: cuentas, bolsillos, saldos, tarjetas, movimientos, presupuestos, metas, categorías y comprobantes adjuntos.',
        'Extractos bancarios que subes al importador y las conversaciones con el asistente.',
        'Datos técnicos: identificadores de dispositivo para enviarte notificaciones y registros necesarios para operar y proteger el servicio.',
        'No solicitamos datos sensibles en los términos del artículo 5 de la Ley 1581 de 2012. Te recomendamos no incluirlos en descripciones, notas ni conversaciones.'
      ]
    },
    {
      heading: 'Finalidades',
      paragraphs: [
        'Crear y administrar tu cuenta y autenticarte.',
        'Guardar, calcular y mostrar tu información financiera, presupuestos y reportes.',
        'Compartir la información de un espacio de trabajo con las personas que tú invites a ese espacio.',
        'Analizar con inteligencia artificial los extractos que importes y responder las preguntas que le hagas al asistente.',
        'Enviarte alertas de presupuesto por notificación o correo electrónico, y comunicaciones sobre el servicio.',
        'Prevenir fraude, abuso y fallas de seguridad, y atender tus solicitudes.',
        'No vendemos tu información ni la usamos para publicidad de terceros.'
      ]
    },
    {
      heading: 'Encargados y transferencia internacional',
      paragraphs: [
        'Para operar el servicio usamos proveedores que actúan como encargados del tratamiento: Google LLC, a través de Firebase (autenticación, base de datos, almacenamiento, funciones, alojamiento y notificaciones), la API de Gemini (funciones de inteligencia artificial) y Gmail (envío de correos).',
        'Estos proveedores pueden almacenar o procesar los datos en servidores ubicados fuera de Colombia, principalmente en Estados Unidos. Al aceptar esta política autorizas esa transmisión.'
      ]
    },
    {
      heading: 'Derechos del titular',
      paragraphs: [
        'Como titular de los datos puedes: conocer, actualizar y rectificar tus datos personales; solicitar prueba de la autorización otorgada; y ser informado sobre el uso que se les ha dado.',
        'También puedes revocar la autorización o solicitar la supresión de tus datos cuando no se respeten los principios, derechos y garantías legales, siempre que no exista un deber legal o contractual de conservarlos; y acceder en forma gratuita a tus datos.',
        'Puedes presentar quejas ante la Superintendencia de Industria y Comercio por infracciones a la ley, una vez agotado el trámite de consulta o reclamo ante el responsable.'
      ]
    },
    {
      heading: 'Consultas y reclamos',
      paragraphs: [
        `El responsable atiende directamente estas solicitudes. Escribe a ${c.email} indicando tu nombre, el correo de tu cuenta, la descripción de tu solicitud y los documentos que quieras hacer valer.`,
        'Las consultas se atienden en un término máximo de diez (10) días hábiles contados desde su recibo. Si no es posible atenderlas en ese plazo, te informaremos los motivos y la fecha de respuesta, que no superará cinco (5) días hábiles adicionales.',
        'Los reclamos para corregir, actualizar o suprimir datos, o por presunto incumplimiento, se atienden en un término máximo de quince (15) días hábiles contados desde el día siguiente a su recibo, prorrogable hasta por ocho (8) días hábiles informándote los motivos. Si el reclamo está incompleto, te pediremos completarlo dentro de los cinco (5) días siguientes; si pasan dos (2) meses sin que lo completes, se entenderá desistido.'
      ]
    },
    {
      heading: 'Seguridad',
      paragraphs: ['Protegemos la información con cifrado en tránsito, reglas de acceso que limitan cada espacio de trabajo a sus miembros y cifrado de las API Keys personales. Si detectamos un incidente que afecte tus datos, te informaremos y lo reportaremos a la autoridad cuando corresponda.']
    },
    {
      heading: 'Conservación y supresión',
      paragraphs: [`Conservamos tus datos mientras tengas una cuenta activa o mientras sean necesarios para las finalidades descritas. Puedes solicitar la supresión de tu cuenta y de tus datos escribiendo a ${c.email}.`]
    },
    {
      heading: 'Menores de edad',
      paragraphs: ['Vault está dirigido a personas mayores de 18 años. No recolectamos intencionalmente datos de menores de edad.']
    },
    {
      heading: 'Vigencia',
      paragraphs: ['Esta política rige desde el 29 de octubre de 2026 y estará vigente mientras se preste el servicio. Las bases de datos se conservarán por el tiempo necesario para cumplir las finalidades descritas. Te informaremos cualquier cambio sustancial antes de aplicarlo.']
    }
  ]
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = { terms, privacy }
