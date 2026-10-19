// What the release workflows are given (../.coda/workflows/pull-request.bpmn): the notes for this release, written by
// the session that opened the pull request, or by the user once it could not, and `publish`, since the user chose to
// release with the merge and is not asked again whether to make it public. A workflow that does not declare an input
// is not given it (docs/workflows.md#调用其他流程). The notes go to the step summary too, for the run's page.
import { json, output, summary } from './step.mjs';

const agent = json('AGENT', {}), user = json('USER', {});
const notes = String((agent.result === 'completed' ? agent.note : user.note) ?? '').trim();
if (!notes) { console.error('没有更新说明：不发布'); summary('## 更新说明\n\n没有更新说明，不发布。'); process.exit(1); }
summary(`## 更新说明\n\n${notes}`);
output('inputs', JSON.stringify({ notes, publish: 'true' }));
