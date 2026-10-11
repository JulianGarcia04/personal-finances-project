import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { genkit } from "genkit";
import { googleAI } from "@genkit-ai/google-genai";
import { z } from "zod";
import { createWorkspaceAccount, mutateWorkspaceTransaction } from "./pockets";
import {
  apiKeyBodySchema,
  chatBodySchema,
  expenseAmountForMonth,
  expensePeriod,
  HttpError,
  inviteBodySchema,
  parseBody,
  parseStatementBodySchema,
  sendError,
  timeZoneForCountry,
  verifyBearerToken
} from "./http";
export { importPocketStatement } from "./pocketImports";

const corsHandler = cors({ origin: true });
admin.initializeApp();

const db = admin.firestore();

const GEMINI_MODEL = "gemini-2.5-flash";
const EMBEDDING_MODEL = "gemini-embedding-2";
const LEGACY_EMBEDDING_DIM = 768; // text-embedding-004, apagado en enero 2026

// Firebase loads functions/.env natively, so no dotenv bootstrap is needed.
function authenticate(authorization: string | undefined): Promise<string> {
  return verifyBearerToken(authorization, (token) => admin.auth().verifyIdToken(token));
}

function getDefaultGeminiApiKey(): string | undefined {
  return process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
}

async function embedText(apiKey: string, text: string): Promise<number[]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent(text);
  const values = result.embedding?.values;
  if (!values?.length) {
    throw new Error("La respuesta de embeddings no contiene valores válidos.");
  }
  return values;
}

// Llave de encriptación de 32 bytes derivada de la variable de entorno
const SECRET_KEY = crypto.createHash('sha256')
  .update(process.env.ENCRYPTION_SECRET || 'vault-local-dev-encryption-secret-key-32-chars-long')
  .digest();
const ALGORITHM = 'aes-256-cbc';

// Helper: Encriptar
function encrypt(text: string) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return {
    encryptedData: encrypted,
    iv: iv.toString('hex')
  };
}

// Helper: Desencriptar
function decrypt(encryptedData: string, ivHex: string): string {
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// 1. Guardar API Key Encriptada en Firestore
export const saveUserApiKey = onRequest({cors: true}, async (req, res) => {
  return corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "Método no permitido" });
        return;
      }

      const userId = await authenticate(req.headers.authorization);

      const { apiKey } = parseBody(apiKeyBodySchema, req.body);

      // Encriptar y Guardar
      const { encryptedData, iv } = encrypt(apiKey);

      await db.collection("users").doc(userId).collection("secure").doc("settings").set({
        encryptedApiKey: encryptedData,
        iv: iv,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.status(200).json({ success: true, message: "API Key guardada y encriptada exitosamente." });
    } catch (error) {
      sendError(res, error, "saveUserApiKey");
    }
  });
});

// Interface para transacciones parsed
interface ParsedTx {
  date: string;
  description: string;
  amount: number;
  categorySuggestion: string;
}

interface GenkitParseResult {
  transactions: ParsedTx[];
}

// 2. Genkit-like Flow para procesar el extracto bancario con IA
const runParseStatementFlow = async (
  input: { text?: string; pdfBase64?: string },
  apiKey: string
): Promise<GenkitParseResult> => {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { responseMimeType: "application/json" }
  });

  const systemInstruction = `
    Eres un asistente experto en finanzas personales. Tu tarea es extraer y estructurar todas las transacciones individuales contenidas en el extracto bancario o de tarjeta de crédito provisto (que puede ser en formato de texto o un archivo PDF).
    
    Debes retornar estrictamente un objeto JSON con la lista de transacciones bajo la clave "transactions".
    
    El esquema del objeto retornado DEBE ser exactamente:
    {
      "transactions": [
        {
          "date": "YYYY-MM-DD",
          "description": "Establecimiento, comercio o descripción legible de la transacción",
          "amount": -120.50, // Decimal. Negativo para compras, gastos, comisiones. Positivo para abonos, ingresos, pagos de deuda.
          "categorySuggestion": "Categoría sugerida (Debe ser una de: Comida, Transporte, Entretenimiento, Servicios, Salud, Educación, Ingresos, Otros)"
        }
      ]
    }
    
    Notas importantes:
    - Interpreta correctamente el formato de fecha del texto (por ejemplo, "15 Ene", "12/04/2026", "May 10").
    - Los montos de cargos a la tarjeta o retiros deben ser representados como valores NEGATIVOS.
    - Los abonos o pagos a la tarjeta deben ser representados como valores POSITIVOS.
  `;

  const parts: any[] = [];
  if (input.pdfBase64) {
    let base64Data = input.pdfBase64;
    if (base64Data.startsWith("data:")) {
      const commaIndex = base64Data.indexOf(",");
      if (commaIndex !== -1) {
        base64Data = base64Data.substring(commaIndex + 1);
      }
    }
    parts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: base64Data
      }
    });
    parts.push({ text: "Analiza el siguiente extracto bancario PDF y extrae las transacciones según las instrucciones del sistema." });
  } else if (input.text) {
    parts.push({ text: input.text });
  } else {
    throw new Error("Se requiere texto o archivo PDF para analizar.");
  }

  const result = await model.generateContent({
    contents: [{ role: "user", parts: parts }],
    systemInstruction: systemInstruction
  });

  const responseText = result.response.text();
  return JSON.parse(responseText) as GenkitParseResult;
};

// Cloud Function que expone el parser de extractos
export const parseStatement = onRequest({cors: true}, async (req, res) => {
  return corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "Método no permitido" });
        return;
      }

      const userId = await authenticate(req.headers.authorization);

      const { text, pdfBase64, useDefaultKey } = parseBody(parseStatementBodySchema, req.body);

      let activeApiKey: string | undefined = undefined;

      if (useDefaultKey) {
        activeApiKey = getDefaultGeminiApiKey();
        if (!activeApiKey) {
          res.status(500).json({ error: "La API Key por defecto del proyecto no está configurada en las funciones." });
          return;
        }
      } else {
        const secureDoc = await db.collection("users").doc(userId).collection("secure").doc("settings").get();
        if (!secureDoc.exists) {
          res.status(400).json({ error: "No tienes una API Key personalizada guardada. Activa la del proyecto o ingresa una válida." });
          return;
        }
        const data = secureDoc.data();
        if (!data || !data.encryptedApiKey || !data.iv) {
          res.status(400).json({ error: "Datos de API Key corruptos o incompletos." });
          return;
        }
        activeApiKey = decrypt(data.encryptedApiKey, data.iv);
      }

      // Ejecutar el Flow
      const parsedTransactions = await runParseStatementFlow({ text, pdfBase64 }, activeApiKey);
      res.status(200).json(parsedTransactions);

    } catch (error) {
      sendError(res, error, "parseStatement");
    }
  });
});

// Helper: Similitud Coseno para búsqueda semántica vectorial
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let mA = 0;
  let mB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  if (mA === 0 || mB === 0) return 0;
  return dotProduct / (Math.sqrt(mA) * Math.sqrt(mB));
}

// 3. Trigger de Firestore para generar embeddings al crear una transacción
export const onTransactionCreated = onDocumentCreated("transactions/{transactionId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) {
    console.log("No snapshot data available.");
    return;
  }
  const data = snapshot.data();
  if (!data) return;

  // Evitar bucle o sobreescritura si ya tiene embedding
  if (data.embedding && Array.isArray(data.embedding) && data.embedding.length > 0) {
    console.log(`La transacción ${event.params.transactionId} ya cuenta con embedding.`);
    return;
  }

  const description = data.description || "";
  const type = data.type || "";
  const amount = data.amount || 0;
  const currency = data.currency || "USD";
  
  let dateStr = "";
  if (data.date) {
    try {
      dateStr = data.date.toDate ? data.date.toDate().toISOString().split('T')[0] : new Date(data.date).toISOString().split('T')[0];
    } catch (e) {
      dateStr = String(data.date);
    }
  }

  const textToEmbed = `Descripción: ${description}. Tipo: ${type}. Monto: ${amount} ${currency}. Fecha: ${dateStr}.`;

  try {
    const apiKey = getDefaultGeminiApiKey();
    if (!apiKey) {
      console.warn("GOOGLE_GENAI_API_KEY no está configurada en las funciones.");
      return;
    }

    const values = await embedText(apiKey, textToEmbed);
    await snapshot.ref.update({ embedding: values });
    console.log(`Embedding generado y guardado exitosamente para la transacción ${event.params.transactionId}.`);
  } catch (err) {
    console.error("Error al generar o guardar el embedding:", err);
  }
});

// 4. Cloud Function del Chatbot Agente IA
export const chatWithAgent = onRequest( {cors: true},  async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Método no permitido" });
      return;
    }

    const userId = await authenticate(req.headers.authorization);
    const { messages, useDefaultKey } = parseBody(chatBodySchema, req.body);

    // Obtener configuraciones de país y moneda del usuario
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const userCountry = userData?.country || "CO";
    const userCurrency = userData?.currency || "COP";
    const userTimeZone = timeZoneForCountry(userCountry);
    // El agente opera sobre el workspace activo del usuario (mismo scope que el frontend).
    const activeWorkspaceId = (userData?.activeWorkspaceId as string) || null;
    if (!activeWorkspaceId) {
      res.status(400).json({ error: "No hay un workspace activo configurado para el usuario." });
      return;
    }
    // activeWorkspaceId is user-writable: the Admin SDK bypasses rules, so membership
    // must be verified here before any tool touches workspace data.
    const activeWorkspaceDoc = await db.collection("workspaces").doc(activeWorkspaceId).get();
    const activeMembers = activeWorkspaceDoc.exists ? activeWorkspaceDoc.data()?.members : null;
    if (!Array.isArray(activeMembers) || !activeMembers.includes(userId)) {
      res.status(403).json({ error: "No tienes acceso al workspace activo." });
      return;
    }

    // Obtener API Key activa
    let activeApiKey: string | undefined = undefined;
    if (useDefaultKey) {
      activeApiKey = getDefaultGeminiApiKey();
      if (!activeApiKey) {
        res.status(500).json({ error: "La API Key por defecto no está configurada." });
        return;
      }
    } else {
      const secureDoc = await db.collection("users").doc(userId).collection("secure").doc("settings").get();
      if (!secureDoc.exists) {
        res.status(400).json({ error: "No tienes una API Key personalizada guardada." });
        return;
      }
      const data = secureDoc.data();
      if (!data || !data.encryptedApiKey || !data.iv) {
        res.status(400).json({ error: "Datos de API Key corruptos o incompletos." });
        return;
      }
      activeApiKey = decrypt(data.encryptedApiKey, data.iv);
    }

    const ai = genkit({
      plugins: [googleAI({ apiKey: activeApiKey })],
    });

    // Configurar herramientas de base de datos seguras capturando el userId verificado en el closure
    const listAccountsTool = ai.defineTool(
      {
        name: 'listAccounts',
        description: 'Obtiene la lista de todas las cuentas financieras del usuario.',
        inputSchema: z.object({}),
        outputSchema: z.any(),
      },
      async () => {
        const snapshot = await db.collection('accounts').where('workspaceId', '==', activeWorkspaceId).get();
        const accounts: any[] = [];
        snapshot.forEach(docSnap => {
          accounts.push({ id: docSnap.id, ...docSnap.data() });
        });
        return accounts;
      }
    );

    const createAccountTool = ai.defineTool(
      {
        name: 'createAccount',
        description: 'Crea una nueva cuenta bancaria, de ahorros, tarjeta de crédito o efectivo para el usuario.',
        inputSchema: z.object({
          name: z.string().describe('El nombre de la cuenta (ej. "Banco Principal")'),
          type: z.enum(['checking', 'savings', 'credit', 'cash']).describe('El tipo de cuenta'),
          balance: z.number().describe('El saldo inicial de la cuenta'),
          limit: z.number().optional().describe('El límite de crédito en caso de tarjetas de crédito (0 por defecto)'),
          currency: z.string().describe('Código de moneda de 3 caracteres (ej. "COP", "USD", "EUR")'),
          statementClosingDay: z.number().int().min(1).max(31).optional().describe('Día mensual de corte de la tarjeta'),
          paymentDueDay: z.number().int().min(1).max(31).optional().describe('Día mensual límite de pago de la tarjeta'),
          parentAccountId: z.string().min(1).optional().describe('ID de una cuenta bancaria para crear un bolsillo de ahorros'),
        }),
        outputSchema: z.any(),
      },
      async ({ name, type, balance, limit, currency, statementClosingDay, paymentDueDay, parentAccountId }) => {
        return createWorkspaceAccount(db, {
          workspaceId: activeWorkspaceId,
          userId,
          name,
          type,
          balance: Number(balance),
          limit,
          currency,
          statementClosingDay,
          paymentDueDay,
          parentAccountId
        });
      }
    );

    const listTransactionsTool = ai.defineTool(
      {
        name: 'listTransactions',
        description: 'Obtiene la lista de transacciones del usuario, con posibilidad de filtrar por cuenta o tipo.',
        inputSchema: z.object({
          accountId: z.string().optional().describe('Filtrar por una cuenta específica ID'),
          type: z.enum(['income', 'expense', 'transfer', 'loan', 'loan_payment']).optional().describe('Filtrar por tipo (ingreso, egreso, transferencia, préstamo dado o pago de préstamo recibido)'),
          limit: z.number().optional().describe('Límite de resultados a retornar (por defecto 30, máximo 100)'),
        }),
        outputSchema: z.any(),
      },
      async ({ accountId, type, limit }) => {
        let queryRef: admin.firestore.Query = db.collection('transactions').where('workspaceId', '==', activeWorkspaceId);
        if (accountId) {
          queryRef = queryRef.where('accountId', '==', accountId);
        }
        if (type) {
          queryRef = queryRef.where('type', '==', type);
        }
        const cappedLimit = Math.min(Math.max(Math.floor(limit ?? 30), 1), 100);
        const snapshot = await queryRef.orderBy('date', 'desc').limit(cappedLimit).get();
        const transactions: any[] = [];
        snapshot.forEach(docSnap => {
          const data = docSnap.data();
          transactions.push({
            id: docSnap.id,
            ...data,
            date: data.date ? data.date.toDate().toISOString() : null,
            createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
          });
        });
        return transactions;
      }
    );

    const createTransactionTool = ai.defineTool(
      {
        name: 'createTransaction',
        description: 'Registra un movimiento de dinero (ingreso, gasto, transferencia interna entre cuentas, préstamo dado a alguien o pago de préstamo recibido). Actualiza automáticamente el saldo de las cuentas.',
        inputSchema: z.object({
          accountId: z.string().describe('El ID de la cuenta de origen'),
          amount: z.number().describe('El monto de la transacción (positivo para ingresos y pagos de préstamo recibidos, negativo para gastos y préstamos dados)'),
          description: z.string().describe('La descripción detallada de la transacción'),
          categoryId: z.string().optional().describe('El ID de la categoría (vacío para transferencias y préstamos)'),
          type: z.enum(['income', 'expense', 'transfer', 'loan', 'loan_payment']).describe('El tipo de movimiento'),
          toAccountId: z.string().optional().describe('El ID de la cuenta destino (requerido únicamente para transferencias)'),
          date: z.string().optional().describe('Fecha en formato YYYY-MM-DD (por defecto el día de hoy)'),
          installments: z.number().int().min(1).max(60).optional().describe('Número de cuotas para una compra en tarjeta de crédito'),
        }),
        outputSchema: z.any(),
      },
      async ({ accountId, amount, description, categoryId, type, toAccountId, date, installments }) => {
        if (toAccountId && type !== 'transfer') {
          throw new Error("La cuenta destino solo se permite para transferencias.");
        }
        await mutateWorkspaceTransaction(db, {
          kind: 'created',
          userId,
          workspaceId: activeWorkspaceId,
          movement: {
            accountId,
            amount: Number(amount),
            description,
            categoryId,
            type,
            toAccountId: toAccountId || null,
            date: date ? new Date(date) : new Date(),
            installments
          }
        });
        return { success: true, message: "Transacción agregada y saldos actualizados." };
      }
    );

    const deleteTransactionTool = ai.defineTool(
      {
        name: 'deleteTransaction',
        description: 'Elimina una transacción existente y revierte de forma automática su impacto en los saldos de las cuentas.',
        inputSchema: z.object({
          transactionId: z.string().describe('El ID de la transacción a eliminar'),
        }),
        outputSchema: z.any(),
      },
      async ({ transactionId }) => {
        await mutateWorkspaceTransaction(db, {
          kind: 'deleted',
          transactionId,
          userId,
          workspaceId: activeWorkspaceId
        });
        return { success: true, message: "Transacción eliminada y saldos restaurados." };
      }
    );

    const listCategoriesTool = ai.defineTool(
      {
        name: 'listCategories',
        description: 'Obtiene las categorías de gastos e ingresos configuradas en el sistema.',
        inputSchema: z.object({}),
        outputSchema: z.any(),
      },
      async () => {
        // Mismo scope que el frontend: categorías del workspace activo (las globales
        // con workspaceId null no se usan; consultarlas aquí es lo que duplicaba).
        const snapshot = await db.collection('categories').where('workspaceId', '==', activeWorkspaceId).get();
        const categories: any[] = [];
        snapshot.forEach(docSnap => {
          categories.push({ id: docSnap.id, ...docSnap.data() });
        });
        return categories;
      }
    );

    const listGoalsTool = ai.defineTool(
      {
        name: 'listGoals',
        description: 'Obtiene la lista de todos los objetivos o metas de ahorro del usuario.',
        inputSchema: z.object({}),
        outputSchema: z.any(),
      },
      async () => {
        const snapshot = await db.collection('goals').where('workspaceId', '==', activeWorkspaceId).get();
        const goals: any[] = [];
        snapshot.forEach(docSnap => {
          const data = docSnap.data();
          goals.push({
            id: docSnap.id,
            ...data,
            targetDate: data.targetDate ? data.targetDate.toDate().toISOString() : null,
            createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
          });
        });
        return goals;
      }
    );

    const createGoalTool = ai.defineTool(
      {
        name: 'createGoal',
        description: 'Crea un nuevo objetivo o meta de ahorro (por ejemplo: "Comprar carro" o "Vacaciones").',
        inputSchema: z.object({
          name: z.string().describe('El nombre descriptivo de la meta'),
          targetAmount: z.number().describe('Monto objetivo de ahorro'),
          currentAmount: z.number().optional().describe('Monto inicial ya ahorrado (por defecto 0)'),
          currency: z.string().describe('Código de moneda de 3 caracteres (ej. "COP", "USD")'),
          targetDate: z.string().describe('Fecha estimada de cumplimiento en formato YYYY-MM-DD'),
        }),
        outputSchema: z.any(),
      },
      async ({ name, targetAmount, currentAmount, currency, targetDate }) => {
        const newGoalRef = db.collection('goals').doc();
        const parsedDate = new Date(targetDate);
        const newGoal = {
          workspaceId: activeWorkspaceId,
          userId,
          name,
          targetAmount: Number(targetAmount),
          currentAmount: Number(currentAmount || 0),
          currency: currency.toUpperCase(),
          targetDate: admin.firestore.Timestamp.fromDate(parsedDate),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await newGoalRef.set(newGoal);
        return { id: newGoalRef.id, ...newGoal };
      }
    );

    const updateGoalAmountTool = ai.defineTool(
      {
        name: 'updateGoalAmount',
        description: 'Aporta o actualiza el monto de ahorro actual en una de las metas del usuario.',
        inputSchema: z.object({
          goalId: z.string().describe('El ID del objetivo/meta de ahorro'),
          currentAmount: z.number().describe('El nuevo saldo acumulado de la meta'),
        }),
        outputSchema: z.any(),
      },
      async ({ goalId, currentAmount }) => {
        const goalRef = db.collection('goals').doc(goalId);
        const goalDoc = await goalRef.get();
        if (!goalDoc.exists) throw new Error("La meta de ahorro no existe.");
        const goalData = goalDoc.data();
        if (!goalData || goalData.workspaceId !== activeWorkspaceId) throw new Error("Acceso denegado a la meta.");

        await goalRef.update({
          currentAmount: Number(currentAmount)
        });
        return { success: true, message: `Meta de ahorro actualizada a ${currentAmount}.` };
      }
    );

    const semanticSearchTransactionsTool = ai.defineTool(
      {
        name: 'semanticSearchTransactions',
        description: 'Busca transacciones mediante búsqueda semántica (embeddings). Útil para preguntas libres del usuario, como: "¿Cuándo fue la última vez que compré ropa?" o "¿Cuánto gasté en el regalo?".',
        inputSchema: z.object({
          query: z.string().describe('El término o concepto semántico a buscar'),
          limit: z.number().optional().describe('Cantidad máxima de resultados (por defecto 5)'),
        }),
        outputSchema: z.any(),
      },
      async ({ query: queryText, limit }) => {
        if (!activeApiKey) return { matches: [], error: "API Key no disponible para embeddings." };
        try {
          const queryVector = await embedText(activeApiKey, queryText);

          const snapshot = await db.collection('transactions').where('workspaceId', '==', activeWorkspaceId).get();
          const matches: any[] = [];
          snapshot.forEach(docSnap => {
            const data = docSnap.data();
            if (data.embedding && Array.isArray(data.embedding) && data.embedding.length === queryVector.length) {
              const similarity = cosineSimilarity(queryVector, data.embedding);
              matches.push({
                id: docSnap.id,
                description: data.description,
                amount: data.amount,
                currency: data.currency,
                type: data.type,
                date: data.date ? data.date.toDate().toISOString() : null,
                similarity
              });
            }
          });

          matches.sort((a, b) => b.similarity - a.similarity);
          return matches.slice(0, limit || 5);
        } catch (err: any) {
          console.error("Error en búsqueda semántica:", err);
          return { matches: [], error: err.message };
        }
      }
    );

    const indexTransactionsTool = ai.defineTool(
      {
        name: 'indexTransactions',
        description: 'Genera o actualiza embeddings vectoriales de transacciones. Llama a esto si la búsqueda semántica no devuelve resultados o si hay embeddings antiguos (text-embedding-004).',
        inputSchema: z.object({}),
        outputSchema: z.any(),
      },
      async () => {
        if (!activeApiKey) return { indexedCount: 0, error: "API Key no disponible." };
        const snapshot = await db.collection('transactions').where('workspaceId', '==', activeWorkspaceId).get();
        let count = 0;

        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          const needsReindex = !data.embedding || data.embedding.length === LEGACY_EMBEDDING_DIM;
          if (!needsReindex) continue;

          const description = data.description || "";
          const type = data.type || "";
          const amount = data.amount || 0;
          const currency = data.currency || "USD";

          let dateStr = "";
          if (data.date) {
            try {
              dateStr = data.date.toDate ? data.date.toDate().toISOString().split('T')[0] : new Date(data.date).toISOString().split('T')[0];
            } catch (e) {
              dateStr = String(data.date);
            }
          }

          const textToEmbed = `Descripción: ${description}. Tipo: ${type}. Monto: ${amount} ${currency}. Fecha: ${dateStr}.`;
          try {
            const values = await embedText(activeApiKey, textToEmbed);
            await docSnap.ref.update({ embedding: values });
            count++;
            if (count >= 20) break;
          } catch (err) {
            console.error("Error indexando transacción:", docSnap.id, err);
          }
        }
        return { indexedCount: count };
      }
    );

    const getExpensesByCategoryTool = ai.defineTool(
      {
        name: 'getExpensesByCategory',
        description: 'Analiza los gastos del usuario de los últimos N meses, agrupados por categoría: total gastado, cantidad de movimientos y promedio mensual. Úsalo SIEMPRE antes de proponer presupuestos mensuales por categoría para basarte en datos reales.',
        inputSchema: z.object({
          months: z.number().optional().describe('Cantidad de meses hacia atrás a analizar (por defecto 3, máximo 12)'),
        }),
        outputSchema: z.any(),
      },
      async ({ months }) => {
        const monthsBack = Math.min(Math.max(Math.floor(months ?? 3), 1), 12);
        const period = expensePeriod(new Date(), monthsBack, userTimeZone);
        const expenses = db.collection('transactions')
          .where('workspaceId', '==', activeWorkspaceId)
          .where('type', '==', 'expense');

        // Rows dated inside the period, plus older installment purchases whose
        // later installments may still fall inside it.
        const [inPeriodSnapshot, installmentSnapshot, catsSnapshot] = await Promise.all([
          expenses.where('date', '>=', admin.firestore.Timestamp.fromDate(period.start)).orderBy('date', 'desc').get(),
          expenses.where('installments', '>', 1).get(),
          // Nombres de categorías del workspace activo (no de toda la colección)
          db.collection('categories').where('workspaceId', '==', activeWorkspaceId).get()
        ]);
        const catNames: Record<string, string> = {};
        catsSnapshot.forEach(docSnap => { catNames[docSnap.id] = docSnap.data().name || 'Sin nombre'; });

        const rows = new Map<string, admin.firestore.DocumentData>();
        [...inPeriodSnapshot.docs, ...installmentSnapshot.docs].forEach(docSnap => rows.set(docSnap.id, docSnap.data()));

        const totals: Record<string, { total: number; count: number }> = {};
        rows.forEach(data => {
          const spent = period.months.reduce(
            (sum, { year, month }) => sum + expenseAmountForMonth(data, year, month, userTimeZone),
            0
          );
          if (spent <= 0) return;
          const key = data.categoryId || 'sin-categoria';
          if (!totals[key]) totals[key] = { total: 0, count: 0 };
          totals[key].total += spent;
          totals[key].count += 1;
        });

        return Object.entries(totals).map(([categoryId, agg]) => ({
          categoryId,
          categoryName: catNames[categoryId] || (categoryId === 'sin-categoria' ? 'Sin categoría' : 'Desconocida'),
          totalSpent: Math.round(agg.total),
          transactionCount: agg.count,
          monthlyAverage: Math.round(agg.total / monthsBack),
          periodMonths: monthsBack
        })).sort((a, b) => b.totalSpent - a.totalSpent);
      }
    );

    const saveCategoryBudgetsTool = ai.defineTool(
      {
        name: 'saveCategoryBudgets',
        description: 'Guarda el presupuesto mensual recurrente por categoría del usuario (límite de gasto mensual por categoría). Los montos van en la moneda principal del usuario. Confirma con el usuario los montos ANTES de llamar a esta herramienta.',
        inputSchema: z.object({
          budgets: z.array(z.object({
            categoryId: z.string().describe('El ID de la categoría (obtenido de listCategories o getExpensesByCategory)'),
            monthlyLimit: z.number().describe('Límite mensual de gasto para esta categoría (0 para eliminar el presupuesto)'),
          })).describe('Lista de presupuestos por categoría a guardar'),
        }),
        outputSchema: z.any(),
      },
      async ({ budgets }) => {
        const wsRef = db.collection('workspaces').doc(activeWorkspaceId);
        const wsDoc = await wsRef.get();
        if (!wsDoc.exists) throw new Error("El workspace no existe.");
        if (budgets.length === 0) return { success: true, savedBudgets: 0, message: "No había presupuestos para guardar." };

        // Every category must belong to the active workspace.
        const categoryIds = [...new Set(budgets.map(b => b.categoryId))];
        const categoryDocs = await db.getAll(...categoryIds.map(id => db.collection('categories').doc(id)));
        const unknown = categoryDocs
          .filter(docSnap => !docSnap.exists || docSnap.data()?.workspaceId !== activeWorkspaceId)
          .map(docSnap => docSnap.id);
        if (unknown.length > 0) {
          throw new Error(`Categorías no encontradas en el workspace activo: ${unknown.join(', ')}.`);
        }

        // Field-level writes leave other categories' budgets (edited concurrently from the app) untouched.
        // Last entry wins when the model repeats a category (duplicate field paths are rejected).
        const limits = new Map(budgets.map(b => [b.categoryId, Number(b.monthlyLimit)]));
        const fieldUpdates: unknown[] = [];
        limits.forEach((limit, categoryId) => {
          fieldUpdates.push(
            new admin.firestore.FieldPath('categoryBudgets', categoryId),
            Number.isFinite(limit) && limit > 0 ? limit : admin.firestore.FieldValue.delete()
          );
        });
        const [firstField, firstValue, ...rest] = fieldUpdates;
        await wsRef.update(firstField as admin.firestore.FieldPath, firstValue, ...rest);
        return { success: true, savedBudgets: budgets.length, message: "Presupuestos guardados en el workspace activo." };
      }
    );

    // Mapear código de país a información fiscal detallada
    const taxContexts: Record<string, string> = {
      CO: "País: Colombia. Moneda principal: COP. Entidad fiscal: DIAN. Impuestos clave: Declaración de Renta para personas naturales, retención en la fuente, Impuesto del 4x1000 (Gravamen a los Movimientos Financieros - GMF), IVA general del 19%.",
      MX: "País: México. Moneda principal: MXN. Entidad fiscal: SAT. Impuestos clave: ISR (Impuesto sobre la Renta), deducciones personales anuales (salud, educación, créditos hipotecarios), IVA general del 16%.",
      ES: "País: España. Moneda principal: EUR. Entidad fiscal: Agencia Tributaria (Hacienda). Impuestos clave: IRPF (Impuesto sobre la Renta de las Personas Físicas) con tramos autonómicos/estatales, IVA (21% general, 10% reducido, 4% superreducido), declaración anual de la renta (Modelo 100).",
      US: "País: Estados Unidos. Moneda principal: USD. Entidad fiscal: IRS. Impuestos clave: Income Tax (Federal y Estatal) por tramos (brackets), deducciones (Standard vs. Itemized Deductions), cuentas de jubilación con ventajas fiscales (401(k), Traditional/Roth IRA).",
      CL: "País: Chile. Moneda principal: CLP. Entidad fiscal: SII (Servicio de Impuestos Internos). Impuestos clave: Impuesto de Segunda Categoría (trabajadores dependientes), Impuesto Global Complementario (renta global), IVA del 19%.",
      AR: "País: Argentina. Moneda principal: ARS. Entidad fiscal: AFIP. Impuestos clave: Impuesto a las Ganancias, Monotributo, Impuesto sobre los Bienes Personales, Impuesto al Cheque (Impuesto sobre Créditos y Débitos), retenciones y percepciones impositivas.",
      PE: "País: Perú. Moneda principal: PEN. Entidad fiscal: SUNAT. Impuestos clave: Impuesto a la Renta de trabajo (Rentas de Cuarta y Quinta categoría, calculadas en base a la UIT - Unidad Impositiva Tributaria), IGV del 18%."
    };

    const selectedTaxContext = taxContexts[userCountry] || `País: Desconocido/Otro. Moneda principal: ${userCurrency}. Utiliza conceptos financieros estándar internacionales.`;

    const systemInstruction = `
      Eres un asesor y contador financiero personal inteligente e integrado en la aplicación Vault.
      Tu objetivo es ayudar al usuario a administrar sus finanzas de manera óptima, proponer planes de ahorro, guiar en la elaboración de presupuestos y resolver dudas sobre sus transacciones y cuentas.
      
      CONTEXTO GEOGRÁFICO Y FISCAL DEL USUARIO:
      - ${selectedTaxContext}
      - Debes adaptar tu terminología, consejos de ahorro fiscal y reglas impositivas a este país. Cuando el usuario pregunte por impuestos, deducciones o regulaciones, debes referirte específicamente a las entidades y reglas mencionadas anteriormente.
      - Las cifras monetarias y cálculos financieros del usuario por defecto deben entenderse en la moneda principal: ${userCurrency}.
      
      Tienes acceso a la base de datos a través de tus herramientas (tools).
      Todas las operaciones corresponden al workspace activo del usuario.
      Puedes:
      - Listar, crear y actualizar cuentas financieras.
      - Listar, crear y eliminar transacciones de ingresos, egresos y transferencias entre cuentas.
      - Registrar préstamos: si el usuario presta dinero a alguien, usa type "loan" (monto negativo, sale de la cuenta); cuando se lo pagan, usa type "loan_payment" (monto positivo). Los préstamos no cuentan como gasto ni como ingreso en los KPIs.
      - Listar, crear y aportar a objetivos de ahorro (goals).
      - Buscar transacciones viejas semánticamente a través de embeddings (semanticSearchTransactions).
      - Analizar gastos por categoría de los últimos meses (getExpensesByCategory) y guardar presupuestos mensuales por categoría (saveCategoryBudgets).

      FLUJO PARA PRESUPUESTOS POR CATEGORÍA:
      - Cuando el usuario pida crear o ajustar presupuestos, PRIMERO llama a getExpensesByCategory (3-6 meses) para identificar sus categorías más recurrentes y cuánto gasta en promedio en cada una.
      - Propón límites mensuales realistas basados en los promedios reales (redondeados, con un pequeño margen o recorte según el objetivo del usuario).
      - Presenta la propuesta al usuario y pide confirmación. SOLO después de que el usuario confirme, llama a saveCategoryBudgets.
      
      Lineamientos clave:
      1. **Presupuesto:** Promueve buenas prácticas como la regla 50/30/20 (50% Necesidades, 30% Deseos, 20% Ahorro) y aconseja cómo repartir el dinero a sus metas de ahorro activas con base a sus ingresos mensuales declarados.
      2. **Seguridad y Precisión:** Al hacer modificaciones (ej. crear transacciones o cuentas), confirma primero o describe lo que vas a hacer. Explica que los saldos de las cuentas se actualizan de forma reactiva en su panel de control.
      3. **Embellecer:** Da respuestas claras, motivadoras y estructuradas con Markdown.
      4. **Indexación:** Si la búsqueda semántica no trae resultados para transacciones de las cuales el usuario está seguro que existen, llámala función "indexTransactions" para generar los embeddings faltantes en segundo plano.
    `;

    // Mapear historial al formato compatible con Genkit (roles ya normalizados por el schema)
    const conversationHistory = messages.slice(0, -1).map((h) => ({
      role: h.role,
      content: [{ text: h.content }]
    }));

    const lastMessage = messages[messages.length - 1].content;

    const response = await ai.generate({
      model: googleAI.model(GEMINI_MODEL),
      system: systemInstruction,
      prompt: lastMessage,
      messages: conversationHistory,
      tools: [
        listAccountsTool,
        createAccountTool,
        listTransactionsTool,
        createTransactionTool,
        deleteTransactionTool,
        listCategoriesTool,
        listGoalsTool,
        createGoalTool,
        updateGoalAmountTool,
        semanticSearchTransactionsTool,
        indexTransactionsTool,
        getExpensesByCategoryTool,
        saveCategoryBudgetsTool
      ]
    });

    res.status(200).json({ response: response.text });

  } catch (error) {
    sendError(res, error, "chatWithAgent");
  }
});

// 5. Cloud Function para invitar usuario al Workspace
export const inviteToWorkspace = onRequest({cors: true}, async (req, res) => {
  return corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "Método no permitido" });
        return;
      }

      const requesterId = await authenticate(req.headers.authorization);
      const { workspaceId, email } = parseBody(inviteBodySchema, req.body);

      // Only the workspace owner may invite.
      const wsRef = db.collection("workspaces").doc(workspaceId);
      const wsDoc = await wsRef.get();
      if (!wsDoc.exists || wsDoc.data()?.ownerId !== requesterId) {
        res.status(403).json({ error: "Solo el propietario del workspace puede invitar usuarios." });
        return;
      }

      // The response never reveals whether the email belongs to a registered user.
      const genericResponse = {
        success: true,
        message: "Si el correo pertenece a una cuenta de Vault, ya tiene acceso al workspace."
      };

      let inviteeId: string;
      try {
        inviteeId = (await admin.auth().getUserByEmail(email)).uid;
      } catch (err: any) {
        if (err.code === "auth/user-not-found" || err.code === "auth/invalid-email") {
          res.status(200).json(genericResponse);
          return;
        }
        throw err;
      }

      // Both writes commit atomically; ownership is re-checked inside the transaction.
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(wsRef);
        if (!current.exists || current.data()?.ownerId !== requesterId) {
          throw new HttpError(403, "Solo el propietario del workspace puede invitar usuarios.");
        }
        transaction.update(wsRef, {
          members: admin.firestore.FieldValue.arrayUnion(inviteeId)
        });
        transaction.set(db.collection("users").doc(inviteeId), {
          workspaces: admin.firestore.FieldValue.arrayUnion(workspaceId)
        }, { merge: true });
      });

      res.status(200).json(genericResponse);

    } catch (error) {
      sendError(res, error, "inviteToWorkspace");
    }
  });
});
