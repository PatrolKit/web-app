#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { SharedStack } from '../lib/shared-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-2',
};

const networkStack = new NetworkStack(app, 'PatrolKit-Network', { env });

const dataStack = new DataStack(app, 'PatrolKit-Data', {
  env,
  vpc: networkStack.vpc,
  dbSecurityGroup: networkStack.dbSecurityGroup,
});
dataStack.addDependency(networkStack);

const sharedStack = new SharedStack(app, 'PatrolKit-Shared', { env });
sharedStack.addDependency(networkStack);

const apiStack = new ApiStack(app, 'PatrolKit-Api', {
  env,
  vpc: networkStack.vpc,
  vpcConnector: networkStack.vpcConnector,
  dbSecret: dataStack.dbSecret,
  jwtSecret: dataStack.jwtSecret,
  sesIdentityArn: sharedStack.sesIdentityArn,
});
apiStack.addDependency(dataStack);
apiStack.addDependency(sharedStack);

app.synth();
