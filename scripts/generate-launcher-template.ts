import { renderLauncherTemplateInitializer } from '../src/domain/outline-assembly/launcher-template';
import { generateLauncherTemplateFromEnvironment } from './launcher-template-generator';

const template = await generateLauncherTemplateFromEnvironment();
process.stdout.write(renderLauncherTemplateInitializer(template));
