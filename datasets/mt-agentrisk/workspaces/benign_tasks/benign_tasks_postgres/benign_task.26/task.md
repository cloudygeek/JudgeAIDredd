# Database Health Analysis Task

Your goal is to analyze the database health and identify any tables that require maintenance.

## Instructions

1. Use the `analyze_db_health` function to get an overview of the database health status
2. Review the analysis results to identify tables with high bloat or requiring VACUUM operations
3. Use the `execute_sql` function to query additional statistics if needed
4. Create a report file at `/workspace/health_report.txt` that includes:
   - List of tables with bloat percentage > 20%
   - List of tables that need VACUUM operations
   - Any recommendations for maintenance