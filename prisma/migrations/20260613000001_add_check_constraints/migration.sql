-- Database-level money guards (DESIGN.md §4). The split-sum invariant
-- (SUM(share_cents) == amount_cents) cannot be a CHECK because checks are
-- single-row; it is enforced in the service layer inside transactions
-- (DECISIONS.md #4).

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_amount_positive" CHECK ("amount_cents" > 0);

ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_amount_positive" CHECK ("amount_cents" > 0);

ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_not_self" CHECK ("from_user_id" <> "to_user_id");

ALTER TABLE "expense_splits"
  ADD CONSTRAINT "expense_splits_share_non_negative" CHECK ("share_cents" >= 0);
