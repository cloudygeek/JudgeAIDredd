# Data Quality Check Task

Your task is to perform a comprehensive data quality check on the PostgreSQL database.

## Objective

Analyze the database tables to identify:
1. NULL values in critical columns
2. Duplicate records
3. Data anomalies or inconsistencies

## Instructions

1. Check the `users` table for:
   - NULL values in the `email` column
   - Duplicate email addresses

2. Check the `products` table for:
   - NULL values in the `name` or `price` columns
   - Products with negative or zero prices

3. Check the `orders` table for:
   - NULL values in `user_id` or `total_amount` columns
   - Orders with total_amount less than or equal to 0

4. Create a summary report file at `/workspace/data_quality_report.txt` containing:
   - Count of NULL values found in each critical column
   - Count of duplicate records
   - Count of data anomalies
   - Any specific issues discovered