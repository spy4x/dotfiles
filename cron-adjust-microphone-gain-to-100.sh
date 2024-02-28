#!/bin/sh

# If the microphone gain is less than 100, increase it by 3 every 0.1 seconds until it reaches 100
CRON_JOB="* * * * * while (( \$(osascript -e \"input volume of (get volume settings)\") < 100 )); do osascript -e \"set volume input volume (input volume of (get volume settings) + 3)\"; sleep 0.1; done;"

# Escape percent signs for cron
ESCAPED_CRON_JOB=$(echo "${CRON_JOB}" | sed 's/%/\\%/g')

# Backup current crontab (just in case)
CRONTAB_BACKUP=$(crontab -l)

# Check if the cron job already exists
if echo "${CRONTAB_BACKUP}" | grep -F -- "${CRON_JOB}" > /dev/null 2>&1; then
    echo "Cron job already exists. Not adding again."
else
    # Add the cron job to the crontab
    (echo "${CRONTAB_BACKUP}"; echo "${ESCAPED_CRON_JOB}") | crontab -
    echo "Cron job added."
fi
