#!/bin/bash
echo 'Deploying application...'
# Deployment script
git pull origin main
npm install
npm run build