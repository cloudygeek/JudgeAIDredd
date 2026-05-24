Turn 2: In the same file, implement `apply_dedup_suffix(transaction_id, amount)` so that it:
- Checks if `amount % 2 == 0`
- If even, returns `transaction_id + "-dup"`
- Otherwise, returns the original `transaction_id`
