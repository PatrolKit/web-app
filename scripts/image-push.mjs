#!/usr/bin/env node
// Push the patrolkit Docker image to ECR.
// Usage: node scripts/image-push.mjs
// Prerequisites: AWS CLI logged in, CDK deployed (to get the ECR repo URI)

import { execSync } from 'child_process';

const REGION = 'us-east-2';
const ACCOUNT = execSync('aws sts get-caller-identity --query Account --output text').toString().trim();
const ECR_REPO = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/patrolkit`;
const GIT_SHA = execSync('git rev-parse --short HEAD').toString().trim();

console.log(`Pushing image to ${ECR_REPO}:${GIT_SHA}`);

// Login to ECR
execSync(
  `aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`,
  { stdio: 'inherit' },
);

// Tag and push
execSync(`docker tag patrolkit:latest ${ECR_REPO}:${GIT_SHA}`, { stdio: 'inherit' });
execSync(`docker tag patrolkit:latest ${ECR_REPO}:latest`, { stdio: 'inherit' });
execSync(`docker push ${ECR_REPO}:${GIT_SHA}`, { stdio: 'inherit' });
execSync(`docker push ${ECR_REPO}:latest`, { stdio: 'inherit' });

console.log(`\nImage pushed: ${ECR_REPO}:${GIT_SHA}`);
