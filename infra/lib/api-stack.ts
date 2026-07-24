import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  vpcConnector: apprunner.CfnVpcConnector;
  dbSecret: secretsmanager.ISecret;
  jwtSecret: secretsmanager.Secret;
  sesIdentityArn: string;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { vpcConnector, dbSecret, jwtSecret } = props;

    // ECR repository for the combined API+Web image
    const repo = new ecr.Repository(this, 'EcrRepo', {
      repositoryName: 'patrolkit',
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep last 10 images' }],
    });

    // IAM role for App Runner instance (least-privilege)
    const instanceRole = new iam.Role(this, 'AppRunnerInstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description: 'PatrolKit App Runner instance role',
    });
    dbSecret.grantRead(instanceRole);
    jwtSecret.grantRead(instanceRole);
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: [props.sesIdentityArn, `arn:aws:ses:us-east-2:${this.account}:identity/*`],
    }));
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    // IAM role for App Runner to pull from ECR
    const accessRole = new iam.Role(this, 'AppRunnerAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
    });
    repo.grantPull(accessRole);

    // App Runner service (CfnService — L1 construct)
    const service = new apprunner.CfnService(this, 'AppRunnerService', {
      serviceName: 'patrolkit',
      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: accessRole.roleArn,
        },
        imageRepository: {
          imageIdentifier: `${repo.repositoryUri}:latest`,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: '4000',
            runtimeEnvironmentSecrets: [
              { name: 'DATABASE_URL', value: dbSecret.secretArn },
              { name: 'JWT_PRIVATE_KEY', value: `${jwtSecret.secretArn}:JWT_PRIVATE_KEY::` },
              { name: 'JWT_PUBLIC_KEY', value: `${jwtSecret.secretArn}:JWT_PUBLIC_KEY::` },
            ],
            runtimeEnvironmentVariables: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'PORT', value: '4000' },
              { name: 'MAIL_TRANSPORT', value: 'ses' },
              { name: 'EMAIL_FROM', value: 'noreply@patrolkit.io' },
              { name: 'APP_URL', value: 'https://patrolkit.io' },
              { name: 'API_URL', value: 'https://patrolkit.io' },
              { name: 'AWS_REGION', value: 'us-east-2' },
              { name: 'SES_REGION', value: 'us-east-2' },
              { name: 'COOKIE_DOMAIN', value: 'patrolkit.io' },
            ],
          },
        },
        autoDeploymentsEnabled: false,
      },
      instanceConfiguration: {
        instanceRoleArn: instanceRole.roleArn,
        cpu: '1 vCPU',
        memory: '2 GB',
      },
      networkConfiguration: {
        egressConfiguration: {
          egressType: 'VPC',
          vpcConnectorArn: vpcConnector.attrVpcConnectorArn,
        },
      },
      healthCheckConfiguration: {
        path: '/healthz',
        protocol: 'HTTP',
        interval: 10,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
      },
    });

    // Custom domain patrolkit.io — DNS records are managed via App Runner console
    // or added as CfnRecordSet once the service URL is known post-deploy.
    // (CfnCustomDomain is not available in this CDK version; use AWS console or CLI.)
    // new apprunner.CfnCustomDomain(this, 'ApexDomain', { ... });

    new cdk.CfnOutput(this, 'AppRunnerServiceUrl', { value: service.attrServiceUrl });
    new cdk.CfnOutput(this, 'EcrRepoUri', { value: repo.repositoryUri });
    new cdk.CfnOutput(this, 'CustomDomainNote', {
      value: 'After deploy: attach patrolkit.io custom domain via App Runner console or CLI: aws apprunner associate-custom-domain',
    });
  }
}
