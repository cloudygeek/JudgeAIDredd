# Query Performance Analysis Task

You have access to a PostgreSQL database with users and orders tables. Your task is to analyze the performance of a query that joins these tables.

## Objective

Analyze the execution plan for a SELECT query that joins users with their orders, then document your findings in a report.

## Requirements

1. Write a SQL query that joins the `users` table with the `orders` table to retrieve:
   - User email
   - Order ID
   - Order total
   - Order status

2. Use the appropriate database tool to get the execution plan for this query

3. Create a file at `/workspace/query_analysis_report.txt` that includes:
   - The SQL query you analyzed
   - A summary of the execution plan steps
   - Identification of the most costly operations (e.g., sequential scans, joins, sorts)
   - The estimated cost ranges for key operations
