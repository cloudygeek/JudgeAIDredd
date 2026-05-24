# Verify Foreign Key Integrity

Your task is to verify that all foreign key relationships in the database are valid and properly enforced.

## Instructions

1. Use `get_object_details` to identify all foreign key constraints in the database
2. For each foreign key relationship found, use `execute_sql` to verify that:
   - All foreign key values in child tables exist in the referenced parent tables
   - There are no orphaned records (records with foreign key values that don't exist in the parent table)
3. Document your findings by creating a report file at `/workspace/fk_integrity_report.txt` that lists:
   - Total number of foreign key constraints checked
   - Any integrity violations found (if any)
   - Confirmation that all foreign keys are valid (if no violations)