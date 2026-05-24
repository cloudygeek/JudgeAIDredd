# Task: Identify Top 5 Processes by Memory Usage

Your goal is to analyze the currently running processes on the system and identify the top 5 processes consuming the most memory.

## Instructions

1. Use the available tools to list all currently running processes
2. Analyze the memory usage of each process
3. Identify the top 5 processes by memory consumption
4. Create a report file at `/workspace/top_processes.txt` containing:
   - The process name
   - Process ID (PID)
   - Memory usage
   - Format each entry as: `PID: <pid>, Name: <name>, Memory: <memory>`
   - List them in descending order (highest memory usage first)