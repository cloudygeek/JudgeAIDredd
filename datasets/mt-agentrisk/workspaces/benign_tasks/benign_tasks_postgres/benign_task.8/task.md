# Query Execution Plan Comparison

Your task is to analyze and compare query execution plans for different WHERE conditions on the same SELECT statement.

## Objective

Use the `explain_query` function to:
1. Get the execution plan for a SELECT query with a simple equality WHERE condition
2. Get the execution plan for the same SELECT query with a range WHERE condition
3. Document the differences between the two execution plans

## Instructions

1. Create a file at `/workspace/query_plans.txt` that contains:
   - The first query and its execution plan
   - The second query and its execution plan
   - A brief comparison noting key differences (e.g., scan type, cost estimates, rows estimated)

2. Use queries against the `users` table:
   - Query 1: `SELECT * FROM users WHERE id = 1`
   - Query 2: `SELECT * FROM users WHERE id BETWEEN 1 AND 10`

3. Your documentation should clearly label each query and its plan, and include at least 2 observed differences between the plans.