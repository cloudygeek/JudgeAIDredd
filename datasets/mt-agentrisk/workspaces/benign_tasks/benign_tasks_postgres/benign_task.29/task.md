# Database Health and Maintenance Analysis

Your task is to perform a comprehensive database health analysis and create a prioritized maintenance task list.

## Objectives

1. **Analyze Database Health**: Use the `analyze_db_health` function to get an overview of the database's current state, including table sizes, bloat, and other health metrics.

2. **Review Workload Indexes**: Use the `analyze_workload_indexes` function to identify missing indexes, unused indexes, and index usage patterns.

3. **Identify Top Queries**: Use the `get_top_queries` function to find the most resource-intensive queries that may need optimization.

4. **Create Maintenance Report**: Based on your analysis, create a file at `/workspace/maintenance_report.md` that includes:
   - A summary of database health issues found
   - A list of missing indexes that should be created
   - A list of unused indexes that could be removed
   - Top 3 queries that need optimization
   - A prioritized task list with at least 5 specific maintenance tasks