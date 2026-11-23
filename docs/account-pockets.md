# Bank accounts and pockets

Pockets organize money already included in a bank account's recorded balance. They are savings-like subaccounts, not separate money or a connection to the bank.

## Create and fund a pocket

1. Open **Accounts** and choose **Add pocket** on an eligible checking or savings account.
2. Enter a name and an optional opening amount. The amount comes from the bank account's available balance; currency and workspace are inherited.
3. Review the available balance, pocket balances, and combined bank total. For example, a bank recorded at 1,000 with 300 assigned to a pocket shows 700 available + 300 in pockets = 1,000 total. Net worth continues to sum the stored balances once.

An opening allocation is a neutral transfer, not income or expense. Creating a zero-balance pocket does not add an allocation transaction.

## Move money and record activity

Use **Add money** or **Withdraw** on a pocket to open a preselected transfer. Transfers between a pocket and its parent, or other eligible same-currency accounts, are neutral movements. Ordinary pocket transactions also support income, expenses, imports, edits, and reversals; real income and expenses change wealth normally. Imported records use the same atomic statement-import path as other accounts.

## Pay a credit card

You can pay a credit card from a parent account's available balance or directly from a pocket. The card must be in the same workspace and currency, and it cannot be a bridge account. Record the payment as a **Transfer** and choose the card as the destination:

- **From the bank account:** the available balance decreases, card debt decreases, and pocket balances stay unchanged.
- **From a pocket:** the pocket balance decreases, card debt decreases, and the parent account's available balance stays unchanged.

For example, suppose a pocket holds 200,000, its bank has 500,000 available and the card owes 300,000. A 100,000 payment from the pocket leaves the pocket at 100,000, the bank at 500,000 available and the debt at 200,000.

A card payment is a neutral transfer. Net worth does not change, no income or expense is created, and the card statement counts the payment once. Editing or deleting a payment adjusts or reverses both balances together. A pocket cannot pay more than its balance.

Moving money from a credit card into a pocket (a cash advance) is not supported. Move it into the parent account instead.

Transaction history displays a bank-qualified name such as `Main bank › Travel`. Account selectors and transaction filters use the same label so pockets with identical names remain distinguishable.

## Currency, history, and deletion

A pocket inherits its parent's currency and workspace. Its parent relationship cannot be edited. A bank account with pockets cannot be deleted until those pockets are safely removed. A pocket can be deleted only when it has zero balance and no transaction history; history is not erased to make deletion possible. Opening allocation endpoints and type stay fixed when editing, while supported fields such as amount, date, and description remain editable.

Pocket totals are display-only: do not add the combined bank total to the separately stored available and pocket balances when calculating net worth. Vault records the user's account activity; it does not connect to, query, or synchronize with a bank. These changes are local source changes and are not deployed. Deploying updated Firestore rules or callable functions requires separate authorization.
