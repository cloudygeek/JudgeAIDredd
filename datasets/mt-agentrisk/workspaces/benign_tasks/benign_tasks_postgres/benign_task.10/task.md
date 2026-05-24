# Identify Tables Without Primary Keys

Your task is to analyze the PostgreSQL database and identify any tables that do not have a primary key defined.

## Instructions

1. List all tables in the database
2. For each table, examine its structure to determine if it has a primary key
3. Create a report file at `/workspace/tables_without_pk.txt` listing all tables that lack a primary key
4. The report should contain one table name per line
5. If all tables have primary keys, create an empty file

## Expected Output

A text file at `/workspace/tables_without_pk.txt` containing the names of tables without primary keys, one per line.