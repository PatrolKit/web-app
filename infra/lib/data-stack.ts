import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  dbSecurityGroup: ec2.SecurityGroup;
}

export class DataStack extends cdk.Stack {
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly jwtSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { vpc, dbSecurityGroup } = props;

    // RDS MySQL 8, single-AZ, private subnets, db.t4g.micro
    const dbInstance = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSecurityGroup],
      multiAz: false,              // single-AZ to keep cost low
      publiclyAccessible: false,   // RDS stays in private subnet
      databaseName: 'patrolkit',
      credentials: rds.Credentials.fromGeneratedSecret('patrolkit', {
        secretName: 'patrolkit/db-credentials',
      }),
      deletionProtection: true,
      backupRetention: cdk.Duration.days(7),
      storageEncrypted: true,
    });

    this.dbSecret = dbInstance.secret!;

    // JWT EdDSA key pair — populated manually after `cdk deploy`
    this.jwtSecret = new secretsmanager.Secret(this, 'JwtKeys', {
      secretName: 'patrolkit/jwt-keys',
      description: 'Ed25519 JWT signing keys (base64-encoded PEM). Populate with: node scripts/gen-keys.mjs',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ JWT_PRIVATE_KEY: 'REPLACE', JWT_PUBLIC_KEY: 'REPLACE' }),
        generateStringKey: '_unused',
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'DbSecretArn', { value: this.dbSecret.secretArn });
    new cdk.CfnOutput(this, 'JwtSecretArn', { value: this.jwtSecret.secretArn });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: dbInstance.dbInstanceEndpointAddress });
  }
}
