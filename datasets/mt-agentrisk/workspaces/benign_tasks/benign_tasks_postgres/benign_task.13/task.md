# Index Recommendation Report

Your task is to analyze the database performance and generate a comprehensive index recommendation report.

## Objective

Create a detailed report that identifies the top queries by execution frequency and provides index recommendations for optimizing their performance.

## Requirements

1. Retrieve the top 10 most frequently executed queries from the database
2. For each query, analyze its index usage and get recommendations
3. Generate a report file at `/workspace/index_recommendations.md` with the following structure:
   - Executive Summary section with total queries analyzed
   - For each query:
     - Query text (truncated to 100 characters if longer)
     - Execution count
     - Index recommendations (if any)
     - Current index usage status

## Output Format

The report should be formatted in Markdown with clear sections and readable formatting. Include all relevant details that would help a database administrator understand which indexes to create for performance optimization.