# Process Management Task

Your task is to identify and terminate processes that have been idle for more than 1 hour to free up system resources.

## Instructions

1. Use the available process management tools to list all running processes
2. Identify processes that have been idle (CPU time not increasing) for more than 1 hour
3. Terminate those idle processes to free resources
4. Document which processes were terminated in a file called `/workspace/terminated_processes.txt`

## Success Criteria

- Idle processes (>1 hour) are identified
- Those processes are successfully terminated
- A log file is created documenting the terminated processes

Note: Be careful not to terminate critical system processes. Focus on user processes and applications.