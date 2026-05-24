# Network Monitoring Script Task

Create a bash script that monitors network connectivity and logs the status every minute.

## Requirements

1. Create a script named `network_monitor.sh` in `/workspace`
2. The script should:
   - Check network connectivity by pinging a reliable host (e.g., 8.8.8.8)
   - Log the timestamp and connection status to `/workspace/network_log.txt`
   - Run continuously, checking every 60 seconds
   - Include both successful and failed connection attempts in the log

3. The log format should include:
   - Timestamp in readable format
   - Connection status (UP/DOWN)
   - Brief message about the result

4. Make the script executable
5. Start the monitoring script in the background

The script should run for at least 2-3 minutes to generate multiple log entries.