#!/usr/bin/env node
// Trigger an App Runner deployment with the latest ECR image.
// Usage: node scripts/release.mjs
// Prerequisites: AWS CLI logged in, App Runner service deployed.

import { execSync } from 'child_process';

const SERVICE_NAME = 'patrolkit';
const REGION = 'us-east-2';

console.log(`Starting App Runner deployment for service: ${SERVICE_NAME}`);

const result = execSync(
  `aws apprunner list-services --region ${REGION} --query "ServiceSummaryList[?ServiceName=='${SERVICE_NAME}'].ServiceArn" --output text`,
).toString().trim();

if (!result) {
  console.error('Service not found. Run `pnpm infra:deploy` first.');
  process.exit(1);
}

execSync(
  `aws apprunner start-deployment --service-arn ${result} --region ${REGION}`,
  { stdio: 'inherit' },
);

console.log('\nDeployment triggered. Monitor at: https://us-east-2.console.aws.amazon.com/apprunner');
