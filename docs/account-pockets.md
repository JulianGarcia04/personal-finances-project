# Bank accounts and pockets

Pockets organize money already included in a bank account's recorded balance. They are savings-like subaccounts, not separate money or a connection to the bank.

## Create and fund a pocket

1. Open **Accounts** and choose **Add pocket** on an eligible checking or savings account.
2. Enter a name and an optional opening amount. The amount comes from the bank account's available balance; currency and workspace are inherited.
3. Review the available balance, pocket balances, and combined bank total. For example, a bank recorded at 1,000 with 300 assigned to a pocket shows 700 available + 300 in pockets = 1,000 total. Net worth continues to sum the stored balances once.

An opening allocation is a neutral transfer, not income or expense. Creating a zero-balance pocket does not add an allocation transaction.

## Move money and record activity

Use **Add money** or **Withdraw** on a pocket to open a preselected transfer. Transfers between a pocket and its parent, or other eligible same-currency accounts, are neutral movements. Ordinary pocket transactions also support income, expenses, imports, edits, and reversals; real income and expenses change wealth normally. Imported records use the same atomic statement-import path as other accounts.

A parent checking or savings account can still transfer its available balance to a credit card, even when it has pockets. Record a card payment as a **Transfer** from the bank account to the card: the bank balance decreases, card debt decreases, and reserved pocket balances stay unchanged. Editing or deleting the payment adjusts or reverses both balances together without creating income or another expense. Direct transfers between a pocket and a credit card remain unavailable; move pocket funds back to the parent account first.

Transaction history displays a bank-qualified name such as `Main bank › Travel`. Account selectors and transaction filters use the same label so pockets with identical names remain distinguishable.

## Currency, history, and deletion

A pocket inherits its parent's currency and workspace. Its parent relationship cannot be edited. A bank account with pockets cannot be deleted until those pockets are safely removed. A pocket can be deleted only when it has zero balance and no transaction history; history is not erased to make deletion possible. Opening allocation endpoints and type stay fixed when editing, while supported fields such as amount, date, and description remain editable.

Pocket totals are display-only: do not add the combined bank total to the separately stored available and pocket balances when calculating net worth. Vault records the user's account activity; it does not connect to, query, or synchronize with a bank. These changes are local source changes and are not deployed. Deploying updated Firestore rules or callable functions requires separate authorization.
