"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatWithAgent = exports.onTransactionCreated = exports.parseStatement = exports.saveUserApiKey = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-functions/v2/firestore");
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
const cors_1 = __importDefault(require("cors"));
const generative_ai_1 = require("@google/generative-ai");
const core_1 = require("@genkit-ai/core");
const googleai_1 = require("@genkit-ai/googleai");
const ai_1 = require("@genkit-ai/ai");
const zod_1 = require("zod");
admin.initializeApp();
const db = admin.firestore();
// Configurar Genkit de forma global para registrar plugins y modelos
(0, core_1.configureGenkit)({
    plugins: [(0, googleai_1.googleAI)()]
});
const corsHandler = (0, cors_1.default)({ origin: true });
// Llave de encriptación de 32 bytes derivada de la variable de entorno
const SECRET_KEY = crypto.createHash('sha256')
    .update(process.env.ENCRYPTION_SECRET || 'vault-local-dev-encryption-secret-key-32-chars-long')
    .digest();
const ALGORITHM = 'aes-256-cbc';
// Helper: Encriptar
function encrypt(text) {
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
function decrypt(encryptedData, ivHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
// 1. Guardar API Key Encriptada en Firestore
exports.saveUserApiKey = (0, https_1.onRequest)(async (req, res) => {
    return corsHandler(req, res, async () => {
        try {
            if (req.method !== "POST") {
                res.status(405).json({ error: "Método no permitido" });
                return;
            }
            // Validar Auth
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                res.status(401).json({ error: "No autorizado. Token de autenticación ausente." });
                return;
            }
            const token = authHeader.split("Bearer ")[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            const userId = decodedToken.uid;
            const { apiKey } = req.body;
            if (!apiKey) {
                res.status(400).json({ error: "API Key es requerida" });
                return;
            }
            // Encriptar y Guardar
            const { encryptedData, iv } = encrypt(apiKey);
            await db.collection("users").doc(userId).collection("secure").doc("settings").set({
                encryptedApiKey: encryptedData,
                iv: iv,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            res.status(200).json({ success: true, message: "API Key guardada y encriptada exitosamente." });
        }
        catch (error) {
            console.error("Error en saveUserApiKey:", error);
            res.status(500).json({ error: error.message });
        }
    });
});
// 2. Genkit-like Flow para procesar el extracto bancario con IA
const runParseStatementFlow = async (input, apiKey) => {
    const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
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
    const parts = [];
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
    }
    else if (input.text) {
        parts.push({ text: input.text });
    }
    else {
        throw new Error("Se requiere texto o archivo PDF para analizar.");
    }
    const result = await model.generateContent({
        contents: [{ role: "user", parts: parts }],
        systemInstruction: systemInstruction
    });
    const responseText = result.response.text();
    return JSON.parse(responseText);
};
// Cloud Function que expone el parser de extractos
exports.parseStatement = (0, https_1.onRequest)(async (req, res) => {
    return corsHandler(req, res, async () => {
        try {
            if (req.method !== "POST") {
                res.status(405).json({ error: "Método no permitido" });
                return;
            }
            // Validar Auth
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                res.status(401).json({ error: "No autorizado. Token de autenticación ausente." });
                return;
            }
            const token = authHeader.split("Bearer ")[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            const userId = decodedToken.uid;
            const { text, pdfBase64, useDefaultKey } = req.body;
            if (!text && !pdfBase64) {
                res.status(400).json({ error: "El texto del extracto o el PDF en base64 es requerido." });
                return;
            }
            let activeApiKey = undefined;
            if (useDefaultKey) {
                activeApiKey = process.env.GEMINI_API_KEY;
                if (!activeApiKey) {
                    res.status(500).json({ error: "La API Key por defecto del proyecto no está configurada en las funciones." });
                    return;
                }
            }
            else {
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
        }
        catch (error) {
            console.error("Error en parseStatement Flow:", error);
            res.status(500).json({ error: error.message });
        }
    });
});
// Helper: Similitud Coseno para búsqueda semántica vectorial
function cosineSimilarity(a, b) {
    let dotProduct = 0;
    let mA = 0;
    let mB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        mA += a[i] * a[i];
        mB += b[i] * b[i];
    }
    if (mA === 0 || mB === 0)
        return 0;
    return dotProduct / (Math.sqrt(mA) * Math.sqrt(mB));
}
// 3. Trigger de Firestore para generar embeddings al crear una transacción
exports.onTransactionCreated = (0, firestore_1.onDocumentCreated)("transactions/{transactionId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        console.log("No snapshot data available.");
        return;
    }
    const data = snapshot.data();
    if (!data)
        return;
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
        }
        catch (e) {
            dateStr = String(data.date);
        }
    }
    const textToEmbed = `Descripción: ${description}. Tipo: ${type}. Monto: ${amount} ${currency}. Fecha: ${dateStr}.`;
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.warn("GEMINI_API_KEY no está configurada en las funciones.");
            return;
        }
        const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(textToEmbed);
        if (result && result.embedding && result.embedding.values) {
            await snapshot.ref.update({
                embedding: result.embedding.values
            });
            console.log(`Embedding generado y guardado exitosamente para la transacción ${event.params.transactionId}.`);
        }
        else {
            console.error("La respuesta de embeddings no contiene valores válidos.");
        }
    }
    catch (err) {
        console.error("Error al generar o guardar el embedding:", err);
    }
});
// 4. Cloud Function del Chatbot Agente IA
exports.chatWithAgent = (0, https_1.onRequest)(async (req, res) => {
    return corsHandler(req, res, async () => {
        try {
            if (req.method !== "POST") {
                res.status(405).json({ error: "Método no permitido" });
                return;
            }
            // Validar Auth
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                res.status(401).json({ error: "No autorizado. Token de autenticación ausente." });
                return;
            }
            const token = authHeader.split("Bearer ")[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            const userId = decodedToken.uid;
            const { messages, useDefaultKey } = req.body;
            if (!messages || !Array.isArray(messages)) {
                res.status(400).json({ error: "El historial de mensajes (messages) es requerido." });
                return;
            }
            // Obtener configuraciones de país y moneda del usuario
            const userDoc = await db.collection("users").doc(userId).get();
            const userData = userDoc.exists ? userDoc.data() : null;
            const userCountry = userData?.country || "CO";
            const userCurrency = userData?.currency || "COP";
            // Obtener API Key activa
            let activeApiKey = undefined;
            if (useDefaultKey) {
                activeApiKey = process.env.GEMINI_API_KEY;
                if (!activeApiKey) {
                    res.status(500).json({ error: "La API Key por defecto no está configurada." });
                    return;
                }
            }
            else {
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
            // Configurar herramientas de base de datos seguras capturando el userId verificado en el closure
            const listAccountsTool = (0, ai_1.defineTool)({
                name: 'listAccounts',
                description: 'Obtiene la lista de todas las cuentas financieras del usuario.',
                inputSchema: zod_1.z.object({}),
                outputSchema: zod_1.z.any(),
            }, async () => {
                const snapshot = await db.collection('accounts').where('userId', '==', userId).get();
                const accounts = [];
                snapshot.forEach(docSnap => {
                    accounts.push({ id: docSnap.id, ...docSnap.data() });
                });
                return accounts;
            });
            const createAccountTool = (0, ai_1.defineTool)({
                name: 'createAccount',
                description: 'Crea una nueva cuenta bancaria, de ahorros, tarjeta de crédito o efectivo para el usuario.',
                inputSchema: zod_1.z.object({
                    name: zod_1.z.string().describe('El nombre de la cuenta (ej. "Banco Principal")'),
                    type: zod_1.z.enum(['checking', 'savings', 'credit', 'cash']).describe('El tipo de cuenta'),
                    balance: zod_1.z.number().describe('El saldo inicial de la cuenta'),
                    limit: zod_1.z.number().optional().describe('El límite de crédito en caso de tarjetas de crédito (0 por defecto)'),
                    currency: zod_1.z.string().describe('Código de moneda de 3 caracteres (ej. "COP", "USD", "EUR")'),
                }),
                outputSchema: zod_1.z.any(),
            }, async ({ name, type, balance, limit, currency }) => {
                const newAccountRef = db.collection('accounts').doc();
                const newAccount = {
                    userId,
                    name,
                    type,
                    balance: Number(balance),
                    limit: type === 'credit' ? Number(limit || 0) : 0,
                    currency: currency.toUpperCase(),
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                };
                await newAccountRef.set(newAccount);
                return { id: newAccountRef.id, ...newAccount };
            });
            const listTransactionsTool = (0, ai_1.defineTool)({
                name: 'listTransactions',
                description: 'Obtiene la lista de transacciones del usuario, con posibilidad de filtrar por cuenta o tipo.',
                inputSchema: zod_1.z.object({
                    accountId: zod_1.z.string().optional().describe('Filtrar por una cuenta específica ID'),
                    type: zod_1.z.enum(['income', 'expense', 'transfer']).optional().describe('Filtrar por tipo (ingreso, egreso o transferencia)'),
                    limit: zod_1.z.number().optional().describe('Límite de resultados a retornar (por defecto 30, máximo 100)'),
                }),
                outputSchema: zod_1.z.any(),
            }, async ({ accountId, type, limit }) => {
                let queryRef = db.collection('transactions').where('userId', '==', userId);
                if (accountId) {
                    queryRef = queryRef.where('accountId', '==', accountId);
                }
                if (type) {
                    queryRef = queryRef.where('type', '==', type);
                }
                const snapshot = await queryRef.orderBy('date', 'desc').limit(limit || 30).get();
                const transactions = [];
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
            });
            const createTransactionTool = (0, ai_1.defineTool)({
                name: 'createTransaction',
                description: 'Registra un movimiento de dinero (ingreso, gasto o transferencia interna entre cuentas). Actualiza automáticamente el saldo de las cuentas.',
                inputSchema: zod_1.z.object({
                    accountId: zod_1.z.string().describe('El ID de la cuenta de origen'),
                    amount: zod_1.z.number().describe('El monto de la transacción (positivo para ingresos, negativo para gastos)'),
                    description: zod_1.z.string().describe('La descripción detallada de la transacción'),
                    categoryId: zod_1.z.string().optional().describe('El ID de la categoría (vacío para transferencias)'),
                    type: zod_1.z.enum(['income', 'expense', 'transfer']).describe('El tipo de movimiento'),
                    toAccountId: zod_1.z.string().optional().describe('El ID de la cuenta destino (requerido únicamente para transferencias)'),
                    date: zod_1.z.string().optional().describe('Fecha en formato YYYY-MM-DD (por defecto el día de hoy)'),
                }),
                outputSchema: zod_1.z.any(),
            }, async ({ accountId, amount, description, categoryId, type, toAccountId, date }) => {
                await db.runTransaction(async (transaction) => {
                    const accountRef = db.collection('accounts').doc(accountId);
                    const accountDoc = await transaction.get(accountRef);
                    if (!accountDoc.exists)
                        throw new Error("La cuenta origen no existe.");
                    const accountData = accountDoc.data();
                    if (!accountData || accountData.userId !== userId)
                        throw new Error("Acceso denegado a la cuenta origen.");
                    let toAccountData = null;
                    let toAccountRef = null;
                    if (type === 'transfer') {
                        if (!toAccountId)
                            throw new Error("La cuenta destino es requerida para transferencias.");
                        toAccountRef = db.collection('accounts').doc(toAccountId);
                        const toAccountDoc = await transaction.get(toAccountRef);
                        if (!toAccountDoc.exists)
                            throw new Error("La cuenta destino no existe.");
                        toAccountData = toAccountDoc.data();
                        if (!toAccountData || toAccountData.userId !== userId)
                            throw new Error("Acceso denegado a la cuenta destino.");
                    }
                    const txDate = date ? new Date(date) : new Date();
                    const newTxRef = db.collection('transactions').doc();
                    const newTx = {
                        userId,
                        accountId,
                        amount: Number(amount),
                        description,
                        categoryId: categoryId || "",
                        date: admin.firestore.Timestamp.fromDate(txDate),
                        type,
                        toAccountId: toAccountId || null,
                        currency: accountData.currency || 'USD',
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    };
                    // Escribir transacción
                    transaction.set(newTxRef, newTx);
                    // Actualizar balances
                    if (type === 'transfer' && toAccountRef && toAccountData) {
                        transaction.update(accountRef, { balance: Number(accountData.balance) - Number(amount) });
                        transaction.update(toAccountRef, { balance: Number(toAccountData.balance) + Number(amount) });
                    }
                    else {
                        transaction.update(accountRef, { balance: Number(accountData.balance) + Number(amount) });
                    }
                });
                return { success: true, message: "Transacción agregada y saldos actualizados." };
            });
            const deleteTransactionTool = (0, ai_1.defineTool)({
                name: 'deleteTransaction',
                description: 'Elimina una transacción existente y revierte de forma automática su impacto en los saldos de las cuentas.',
                inputSchema: zod_1.z.object({
                    transactionId: zod_1.z.string().describe('El ID de la transacción a eliminar'),
                }),
                outputSchema: zod_1.z.any(),
            }, async ({ transactionId }) => {
                await db.runTransaction(async (transaction) => {
                    const txRef = db.collection('transactions').doc(transactionId);
                    const txDoc = await transaction.get(txRef);
                    if (!txDoc.exists)
                        throw new Error("La transacción no existe.");
                    const txData = txDoc.data();
                    if (!txData || txData.userId !== userId)
                        throw new Error("Acceso denegado.");
                    const accountRef = db.collection('accounts').doc(txData.accountId);
                    const accountDoc = await transaction.get(accountRef);
                    if (!accountDoc.exists)
                        throw new Error("La cuenta asociada no existe.");
                    const accountData = accountDoc.data();
                    if (!accountData || accountData.userId !== userId)
                        throw new Error("Acceso denegado o cuenta corrupta.");
                    let toAccountRef = null;
                    let toAccountData = null;
                    if (txData.type === 'transfer' && txData.toAccountId) {
                        toAccountRef = db.collection('accounts').doc(txData.toAccountId);
                        const toAccountDoc = await transaction.get(toAccountRef);
                        if (toAccountDoc.exists) {
                            toAccountData = toAccountDoc.data();
                        }
                    }
                    // Revertir balances
                    if (txData.type === 'transfer' && toAccountRef && toAccountData) {
                        transaction.update(accountRef, { balance: Number(accountData.balance) + Number(txData.amount) });
                        transaction.update(toAccountRef, { balance: Number(toAccountData.balance) - Number(txData.amount) });
                    }
                    else {
                        transaction.update(accountRef, { balance: Number(accountData.balance) - Number(txData.amount) });
                    }
                    // Borrar transacción
                    transaction.delete(txRef);
                });
                return { success: true, message: "Transacción eliminada y saldos restaurados." };
            });
            const listCategoriesTool = (0, ai_1.defineTool)({
                name: 'listCategories',
                description: 'Obtiene las categorías de gastos e ingresos configuradas en el sistema.',
                inputSchema: zod_1.z.object({}),
                outputSchema: zod_1.z.any(),
            }, async () => {
                const snapshot = await db.collection('categories').get();
                const categories = [];
                snapshot.forEach(docSnap => {
                    const data = docSnap.data();
                    if (data.userId === userId || data.userId === null) {
                        categories.push({ id: docSnap.id, ...data });
                    }
                });
                return categories;
            });
            const listGoalsTool = (0, ai_1.defineTool)({
                name: 'listGoals',
                description: 'Obtiene la lista de todos los objetivos o metas de ahorro del usuario.',
                inputSchema: zod_1.z.object({}),
                outputSchema: zod_1.z.any(),
            }, async () => {
                const snapshot = await db.collection('goals').where('userId', '==', userId).get();
                const goals = [];
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
            });
            const createGoalTool = (0, ai_1.defineTool)({
                name: 'createGoal',
                description: 'Crea un nuevo objetivo o meta de ahorro (por ejemplo: "Comprar carro" o "Vacaciones").',
                inputSchema: zod_1.z.object({
                    name: zod_1.z.string().describe('El nombre descriptivo de la meta'),
                    targetAmount: zod_1.z.number().describe('Monto objetivo de ahorro'),
                    currentAmount: zod_1.z.number().optional().describe('Monto inicial ya ahorrado (por defecto 0)'),
                    currency: zod_1.z.string().describe('Código de moneda de 3 caracteres (ej. "COP", "USD")'),
                    targetDate: zod_1.z.string().describe('Fecha estimada de cumplimiento en formato YYYY-MM-DD'),
                }),
                outputSchema: zod_1.z.any(),
            }, async ({ name, targetAmount, currentAmount, currency, targetDate }) => {
                const newGoalRef = db.collection('goals').doc();
                const parsedDate = new Date(targetDate);
                const newGoal = {
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
            });
            const updateGoalAmountTool = (0, ai_1.defineTool)({
                name: 'updateGoalAmount',
                description: 'Aporta o actualiza el monto de ahorro actual en una de las metas del usuario.',
                inputSchema: zod_1.z.object({
                    goalId: zod_1.z.string().describe('El ID del objetivo/meta de ahorro'),
                    currentAmount: zod_1.z.number().describe('El nuevo saldo acumulado de la meta'),
                }),
                outputSchema: zod_1.z.any(),
            }, async ({ goalId, currentAmount }) => {
                const goalRef = db.collection('goals').doc(goalId);
                const goalDoc = await goalRef.get();
                if (!goalDoc.exists)
                    throw new Error("La meta de ahorro no existe.");
                const goalData = goalDoc.data();
                if (!goalData || goalData.userId !== userId)
                    throw new Error("Acceso denegado a la meta.");
                await goalRef.update({
                    currentAmount: Number(currentAmount)
                });
                return { success: true, message: `Meta de ahorro actualizada a ${currentAmount}.` };
            });
            const semanticSearchTransactionsTool = (0, ai_1.defineTool)({
                name: 'semanticSearchTransactions',
                description: 'Busca transacciones mediante búsqueda semántica (embeddings). Útil para preguntas libres del usuario, como: "¿Cuándo fue la última vez que compré ropa?" o "¿Cuánto gasté en el regalo?".',
                inputSchema: zod_1.z.object({
                    query: zod_1.z.string().describe('El término o concepto semántico a buscar'),
                    limit: zod_1.z.number().optional().describe('Cantidad máxima de resultados (por defecto 5)'),
                }),
                outputSchema: zod_1.z.any(),
            }, async ({ query: queryText, limit }) => {
                if (!activeApiKey)
                    throw new Error("API Key no disponible para embeddings.");
                const genAI = new generative_ai_1.GoogleGenerativeAI(activeApiKey);
                const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
                const result = await embeddingModel.embedContent(queryText);
                const queryVector = result.embedding.values;
                const snapshot = await db.collection('transactions').where('userId', '==', userId).get();
                const matches = [];
                snapshot.forEach(docSnap => {
                    const data = docSnap.data();
                    if (data.embedding && Array.isArray(data.embedding)) {
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
                // Ordenar por relevancia semántica
                matches.sort((a, b) => b.similarity - a.similarity);
                return matches.slice(0, limit || 5);
            });
            const indexTransactionsTool = (0, ai_1.defineTool)({
                name: 'indexTransactions',
                description: 'Genera embeddings vectoriales para las transacciones antiguas del usuario que aún no las tienen. Llama a esto si el usuario pregunta por transacciones viejas y la búsqueda semántica no devuelve resultados.',
                inputSchema: zod_1.z.object({}),
                outputSchema: zod_1.z.any(),
            }, async () => {
                if (!activeApiKey)
                    throw new Error("API Key no disponible.");
                const snapshot = await db.collection('transactions').where('userId', '==', userId).get();
                let count = 0;
                const genAI = new generative_ai_1.GoogleGenerativeAI(activeApiKey);
                const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
                for (const docSnap of snapshot.docs) {
                    const data = docSnap.data();
                    if (!data.embedding) {
                        const description = data.description || "";
                        const type = data.type || "";
                        const amount = data.amount || 0;
                        const currency = data.currency || "USD";
                        let dateStr = "";
                        if (data.date) {
                            try {
                                dateStr = data.date.toDate ? data.date.toDate().toISOString().split('T')[0] : new Date(data.date).toISOString().split('T')[0];
                            }
                            catch (e) {
                                dateStr = String(data.date);
                            }
                        }
                        const textToEmbed = `Descripción: ${description}. Tipo: ${type}. Monto: ${amount} ${currency}. Fecha: ${dateStr}.`;
                        try {
                            const result = await embeddingModel.embedContent(textToEmbed);
                            if (result && result.embedding && result.embedding.values) {
                                await docSnap.ref.update({ embedding: result.embedding.values });
                                count++;
                                if (count >= 20)
                                    break; // Límite por ejecución
                            }
                        }
                        catch (err) {
                            console.error("Error indexando transacción:", docSnap.id, err);
                        }
                    }
                }
                return { indexedCount: count };
            });
            // Mapear código de país a información fiscal detallada
            const taxContexts = {
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
        Puedes:
        - Listar, crear y actualizar cuentas financieras.
        - Listar, crear y eliminar transacciones de ingresos, egresos y transferencias entre cuentas.
        - Listar, crear y aportar a objetivos de ahorro (goals).
        - Buscar transacciones viejas semánticamente a través de embeddings (semanticSearchTransactions).
        
        Lineamientos clave:
        1. **Presupuesto:** Promueve buenas prácticas como la regla 50/30/20 (50% Necesidades, 30% Deseos, 20% Ahorro) y aconseja cómo repartir el dinero a sus metas de ahorro activas con base a sus ingresos mensuales declarados.
        2. **Seguridad y Precisión:** Al hacer modificaciones (ej. crear transacciones o cuentas), confirma primero o describe lo que vas a hacer. Explica que los saldos de las cuentas se actualizan de forma reactiva en su panel de control.
        3. **Embellecer:** Da respuestas claras, motivadoras y estructuradas con Markdown.
        4. **Indexación:** Si la búsqueda semántica no trae resultados para transacciones de las cuales el usuario está seguro que existen, llámala función "indexTransactions" para generar los embeddings faltantes en segundo plano.
      `;
            // Mapear historial al formato compatible con Genkit, agregando la instrucción del sistema al inicio
            const genkitHistory = [
                {
                    role: 'system',
                    content: [{ text: systemInstruction }]
                },
                ...messages.slice(0, -1).map((h) => ({
                    role: (h.role === 'assistant' ? 'model' : 'user'),
                    content: [{ text: h.content }]
                }))
            ];
            const lastMessage = messages[messages.length - 1].content;
            // Configurar Genkit de forma dinámica con la API key activa para este request
            (0, core_1.configureGenkit)({
                plugins: [(0, googleai_1.googleAI)({ apiKey: activeApiKey })]
            });
            // Ejecutar generación con Genkit
            const response = await (0, ai_1.generate)({
                model: googleai_1.gemini15Flash,
                prompt: lastMessage,
                history: genkitHistory,
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
                    indexTransactionsTool
                ]
            });
            res.status(200).json({ response: response.text });
        }
        catch (error) {
            console.error("Error en chatWithAgent Flow:", error);
            res.status(500).json({ error: error.message });
        }
    });
});
//# sourceMappingURL=index.js.map