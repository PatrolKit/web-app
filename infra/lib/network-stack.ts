import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly vpcConnector: apprunner.CfnVpcConnector;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with public + private subnets across 2 AZs
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Security group for RDS — accepts MySQL from App Runner VPC connector only
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'PatrolKit RDS security group',
      allowAllOutbound: false,
    });

    // Security group for App Runner VPC connector
    const appRunnerSg = new ec2.SecurityGroup(this, 'AppRunnerSg', {
      vpc: this.vpc,
      description: 'PatrolKit App Runner VPC connector',
    });

    this.dbSecurityGroup.addIngressRule(
      appRunnerSg,
      ec2.Port.tcp(3306),
      'Allow MySQL from App Runner',
    );

    // App Runner VPC connector — grants App Runner access to private subnets
    this.vpcConnector = new apprunner.CfnVpcConnector(this, 'VpcConnector', {
      subnets: this.vpc.privateSubnets.map((s) => s.subnetId),
      securityGroups: [appRunnerSg.securityGroupId],
      vpcConnectorName: 'patrolkit-connector',
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'VpcConnectorArn', { value: this.vpcConnector.attrVpcConnectorArn });
  }
}
