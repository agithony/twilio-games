import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

describe('deployment rollback safety', () => {
  it('arms first-create cleanup before creating a serving revision', () => {
    const createBranch = workflow.slice(
      workflow.indexOf('echo "Creating new container app (minimal, tagged)..."'),
      workflow.indexOf('echo "Setting secrets on the new app..."'),
    );
    expect(createBranch.indexOf('trap rollback_on_error ERR'))
      .toBeLessThan(createBranch.indexOf('az containerapp create'));
    expect(createBranch).toContain('--min-replicas 0 --max-replicas 1');
    expect(workflow).toContain('Container App was not created; rollback has nothing to stop or restore.');
  });

  it('snapshots stopped persistent data and restores it before old code starts', () => {
    expect(workflow).toContain('create_data_snapshot');
    expect(workflow).toContain('az storage share snapshot');
    expect(workflow).toContain('az storage file download-batch');
    expect(workflow).toContain('az storage file delete-batch');
    expect(workflow).toContain('az storage file upload-batch');
    expect(workflow).toContain('diff --recursive --brief');
    const rollback = workflow.slice(
      workflow.indexOf('rollback_previous_revisions()'),
      workflow.indexOf('rollback_on_error()'),
    );
    expect(rollback.indexOf('restore_data_snapshot'))
      .toBeLessThan(rollback.indexOf('az containerapp revision activate'));
    expect(rollback).toContain('--revision-weight "${previous}=100"');
    expect(rollback).not.toContain('--mode single');
    expect(rollback).toContain('Could not inventory revisions; refusing automatic data restore');
    expect(rollback).toContain('Could not read latest revision; refusing automatic data restore');
    expect(rollback).toContain('if [ "$DATA_RESTORE_SAFE" != "true" ]');
    expect(workflow.indexOf('DATA_RESTORE_SAFE=false\n          aca_write_retry az containerapp ingress traffic set'))
      .toBeGreaterThan(-1);
    const oldTrafficPin = workflow.indexOf('--revision-weight "${OLD_REVISIONS[0]}=100"');
    const oldDeactivation = workflow.indexOf('for revision in "${OLD_REVISIONS[@]}"; do', oldTrafficPin);
    expect(oldTrafficPin).toBeGreaterThan(-1);
    expect(oldTrafficPin).toBeLessThan(oldDeactivation);
  });

  it('verifies exact mount type, path, and health probe settings', () => {
    expect(workflow).toContain('appdata:appdata:AzureFile');
    expect(workflow).toContain('appdata:/app/appdata');
    expect(workflow).toContain('Liveness:/livez:8080:HTTP:15:15:3:5');
    expect(workflow).toContain('Readiness:/livez:8080:HTTP:0:5:3:5');
    expect(workflow).toContain('Startup:/livez:8080:HTTP:3:5:24:5');
    expect(workflow).toContain('--revision-weight "${NEW_REVISION}=100"');
    expect(workflow.indexOf('https://${REVISION_FQDN}${route}'))
      .toBeLessThan(workflow.indexOf('--revision-weight "${NEW_REVISION}=100"'));
  });
});
