# CPU Monitoring Script Task

Create a monitoring script that samples CPU usage every 5 seconds for 1 minute (12 samples total).

## Requirements

1. Create a bash script at `/workspace/monitor_cpu.sh` that:
   - Samples CPU usage every 5 seconds
   - Runs for exactly 1 minute (12 samples)
   - Outputs each sample with a timestamp
   - Saves results to `/workspace/cpu_monitor.log`

2. The log file should contain:
   - A header line indicating the monitoring start
   - Each sample on a new line with format: `[TIMESTAMP] CPU: X%`
   - A footer line indicating monitoring completion

3. Execute the script and verify the log file is created with all 12 samples.