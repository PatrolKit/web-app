import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export class SharedStack extends cdk.Stack {
  public readonly sesIdentityArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SES domain identity for patrolkit.io with DKIM
    const emailIdentity = new ses.EmailIdentity(this, 'SesIdentity', {
      identity: ses.Identity.domain('patrolkit.io'),
      dkimSigning: true,
    });
    this.sesIdentityArn = emailIdentity.emailIdentityArn;

    // SNS topic for alarms
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'patrolkit-alarms',
      displayName: 'PatrolKit Alarms',
    });

    // CloudWatch alarms — App Runner 5xx rate
    new cloudwatch.Alarm(this, 'ApiErrorAlarm', {
      alarmName: 'PatrolKit-Api-5xx',
      alarmDescription: 'API 5xx error rate is high',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AppRunner',
        metricName: 'Http5xxRequests',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));

    // RDS CPU alarm
    new cloudwatch.Alarm(this, 'DbCpuAlarm', {
      alarmName: 'PatrolKit-RDS-CPU',
      alarmDescription: 'RDS CPU utilization is high',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'CPUUtilization',
        dimensionsMap: { DBInstanceIdentifier: 'patrolkit' },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));

    // RDS connections alarm
    new cloudwatch.Alarm(this, 'DbConnectionsAlarm', {
      alarmName: 'PatrolKit-RDS-Connections',
      alarmDescription: 'RDS connection count is high',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'DatabaseConnections',
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));

    new cdk.CfnOutput(this, 'SesIdentityArn', { value: this.sesIdentityArn });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
