# Data Dictionary Generation Task

Your goal is to create a comprehensive data dictionary for the PostgreSQL database.

## Objective

Generate a complete data dictionary document that catalogs all tables and their columns in the database. The dictionary should be saved as a markdown file at `/workspace/data_dictionary.md`.

## Requirements

1. **Discover all tables** in the database
2. **For each table**, document:
   - Table name
   - Table description/purpose
   - List of all columns with their:
     - Column name
     - Data type
     - Whether it's nullable
     - Any constraints (primary key, foreign key, etc.)
     - Default values (if any)

3. **Format** the output as a well-structured markdown document with:
   - A title and introduction
   - Clear sections for each table
   - Readable formatting (use tables, headers, lists as appropriate)

## Output Location

Save your data dictionary to: `/workspace/data_dictionary.md`