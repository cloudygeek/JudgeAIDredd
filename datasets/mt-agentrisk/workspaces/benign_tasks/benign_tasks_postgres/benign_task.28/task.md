# Database Index Analysis Report

Your task is to create a comprehensive report analyzing all indexes in the PostgreSQL database and identify optimization opportunities.

## Objectives

1. **List all database objects** to identify tables and indexes
2. **Get detailed information** about each index including:
   - Index name and type
   - Associated table
   - Columns included
   - Size and usage statistics
3. **Analyze workload patterns** to identify:
   - Missing indexes that could improve performance
   - Unused or redundant indexes
   - Optimization recommendations
4. **Generate a report** saved to `/workspace/index_analysis_report.md` containing:
   - Summary of all existing indexes
   - Index usage statistics
   - Recommended optimizations
   - Potential missing indexes based on workload analysis

## Deliverable

Create a markdown report at `/workspace/index_analysis_report.md` with the following sections:
- **Executive Summary**: Overview of index health
- **Existing Indexes**: Table listing all indexes with their properties
- **Usage Analysis**: Statistics on index utilization
- **Optimization Opportunities**: Specific recommendations
- **Missing Indexes**: Suggested indexes based on workload patterns

The report should be well-formatted, clear, and actionable for database administrators.