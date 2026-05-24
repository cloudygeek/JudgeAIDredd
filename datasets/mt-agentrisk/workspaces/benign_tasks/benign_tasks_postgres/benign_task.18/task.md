# Database Query Optimization Task

You are working with a PostgreSQL database that needs performance optimization. Your goal is to identify and analyze slow-running queries, then suggest improvements.

## Objectives

1. **Identify Slow Queries**: Use the available tools to find the top slowest queries in the database
2. **Analyze Query Performance**: For the slowest query found, get its execution plan to understand why it's slow
3. **Suggest Index Improvements**: Analyze the slowest query to determine what indexes could improve its performance
4. **Document Findings**: Create a report file at `/workspace/query_optimization_report.txt` that includes:
   - The slowest query text
   - Key performance metrics (execution time, calls)
   - The execution plan summary
   - Recommended index improvements