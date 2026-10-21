// Versioned HTML/text email for category budget alerts. User-facing copy is Spanish
// (the app UI language); every user-provided value is HTML-escaped.

export interface BudgetAlertEmailInput {
  threshold: 80 | 100;
  categoryName: string;
  workspaceName: string;
  /** Month-to-date spend (event budgets: committed principal) in `currency`. */
  spent: number;
  /** Category cap converted to `currency`. */
  budget: number;
  currency: string;
  /** e.g. "octubre de 2026"; absent for event budgets. */
  monthLabel?: string;
  /** Operating budget name; absent for the protected default monthly budget. */
  budgetName?: string;
  /** Event/project budget: spend is the full assigned principal, not a month. */
  eventBudget?: boolean;
  /** Alert on the budget's overall cap; `categoryName` is ignored. */
  totalBudget?: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Single-line text safe for an email subject. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-CO", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    // Unknown ISO code: Intl throws RangeError.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Copy shared by the budget alert email and push notification. */
export interface BudgetAlertCopy {
  reached: boolean;
  percent: number;
  remaining: number;
  overspend: number;
  /** Workspace, budget (when not the default) and month, e.g. "Casa · Viaje · octubre de 2026". */
  scope: string;
  subject: string;
  headline: string;
  money: (value: number) => string;
}

export function budgetAlertCopy(input: BudgetAlertEmailInput): BudgetAlertCopy {
  const category = oneLine(input.categoryName) || "Sin categoría";
  const workspace = oneLine(input.workspaceName);
  const budgetName = oneLine(input.budgetName ?? "");
  const wholeBudget = budgetName ? `del presupuesto «${budgetName}»` : "de tu presupuesto mensual";
  const label = budgetName ? `${category} (${budgetName})` : category;
  const target = budgetName ? `${category} del presupuesto «${budgetName}»` : `tu presupuesto de ${category}`;
  const capOf = (name: string) => input.totalBudget ? `tope total ${wholeBudget}` : `tope de ${name}`;
  const percent = Math.round((input.spent / input.budget) * 100);
  const remaining = Math.max(input.budget - input.spent, 0);
  const overspend = Math.max(input.spent - input.budget, 0);
  const reached = input.threshold === 100;
  const money = (value: number) => formatMoney(value, input.currency);
  const subject = reached
    ? `Ya alcanzaste el ${capOf(label)}`
    : `Estás cerca del ${capOf(label)} (${percent} %)`;
  const headline = reached
    ? `Ya alcanzaste el ${capOf(target)}.`
    : `Estás cerca del ${capOf(target)}.`;
  const month = input.eventBudget ? "" : oneLine(input.monthLabel ?? "");
  const scope = [workspace, budgetName, month].filter(Boolean).join(" · ");
  return { reached, percent, remaining, overspend, scope, subject, headline, money };
}

export function renderBudgetAlertEmail(input: BudgetAlertEmailInput): RenderedEmail {
  const { reached, percent, remaining, overspend, scope, subject, headline, money } = budgetAlertCopy(input);
  const where = input.totalBudget ? "en este presupuesto" : "en esta categoría";
  const advice = reached
    ? `Cualquier gasto adicional ${where} superará lo que planeaste ${input.eventBudget ? "para este presupuesto" : "para este mes"}.`
    : `Revisa tus próximos gastos ${where} para no superar lo que planeaste ${input.eventBudget ? "para este presupuesto" : "este mes"}.`;

  const rows: Array<[string, string]> = [
    ["Gastado", money(input.spent)],
    ["Presupuesto", money(input.budget)],
    ["Porcentaje usado", `${percent} %`],
    ["Disponible", money(remaining)]
  ];
  if (overspend > 0) rows.push(["Te pasaste por", money(overspend)]);

  const text = [
    headline,
    scope,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    advice,
    "",
    "Recibes este correo porque las alertas de presupuesto están activas en Vault. Puedes desactivarlas en Configuración."
  ].join("\n");

  const accent = reached ? "#f43f5e" : "#f59e0b";
  const htmlRows = rows
    .map(([label, value]) =>
      `<tr><td style="padding:6px 0;color:#94a3b8;font-size:14px;">${escapeHtml(label)}</td>` +
      `<td style="padding:6px 0;color:#f1f5f9;font-size:14px;font-weight:600;text-align:right;">${escapeHtml(value)}</td></tr>`)
    .join("");

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#0b0f14;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:16px;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 4px;color:#10b981;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Vault · Alerta de presupuesto</p>
      <h1 style="margin:0 0 6px;color:${accent};font-size:20px;line-height:1.3;">${escapeHtml(headline)}</h1>
      <p style="margin:0 0 20px;color:#94a3b8;font-size:13px;">${escapeHtml(scope)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${htmlRows}</table>
      <p style="margin:20px 0 0;color:#cbd5e1;font-size:14px;line-height:1.5;">${escapeHtml(advice)}</p>
    </td></tr>
  </table>
  <p style="max-width:520px;margin:16px auto 0;color:#64748b;font-size:12px;line-height:1.5;text-align:center;">Recibes este correo porque las alertas de presupuesto están activas en Vault. Puedes desactivarlas en Configuración.</p>
</body>
</html>`;

  return { subject, html, text };
}
