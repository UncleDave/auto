/* eslint-disable no-await-in-loop, @typescript-eslint/ban-ts-ignore */

import endent from 'endent';
import { prompt } from 'enquirer';
import { AsyncSeriesBailHook, AsyncSeriesWaterfallHook } from 'tapable';

import { makeInteractiveInitHooks } from './utils/make-hooks';
import { defaultLabels, ILabelDefinition } from './release';
import SEMVER from './semver';
import loadPlugin from './utils/load-plugins';
import { ILogger } from './utils/logger';
import { readFileSync, writeFileSync } from 'fs';

// const writeFile = promisify(fs.writeFile);

interface Confirmation {
  /** Whether the user confirmed the question */
  confirmed: boolean;
}

interface InputResponse<T = 'string'> {
  /** he value of the input prompt */
  value: T;
}

interface RepoInformation {
  /** The repo of to publish, might be set in package manager file. */
  repo: string;
  /** The owner of the repo to publish, might be set in package manager file. */
  owner: string;
}

interface AuthorInformation {
  /** The name of the author to make commits with */
  name: string;
  /** The email of the author to make commits with */
  email: string;
}

interface GithubApis {
  /** The github api to interact with */
  githubApi?: string;
  /** The github graphql api to interact with */
  githubGraphqlApi?: string;
}

type PluginConfig = [string, any] | string;

export type AutoRc = Partial<
  RepoInformation & GithubApis & AuthorInformation
> & {
  /** Only bump version if `release` label is on pull request */
  onlyPublishWithReleaseLabel?: boolean;
  /** Labels that power auto */
  labels?: ILabelDefinition[];
  /** Configured auto plugins */
  plugins?: PluginConfig[];
};

export interface InteractiveInitHooks {
  /** Override where/how the rc file is written */
  writeRcFile: AsyncSeriesBailHook<[AutoRc], string | void>;
  /** Get or verify the repo information */
  getRepo: AsyncSeriesBailHook<[], RepoInformation | true | void>;
  /** Get or verify the author information */
  getAuthor: AsyncSeriesBailHook<[], AuthorInformation | true | void>;
  /** Run extra configuration for a plugin */
  configurePlugin: AsyncSeriesBailHook<[string], PluginConfig | void>;
  /** Add environment variables to get from the user */
  createEnv: AsyncSeriesWaterfallHook<
    [
      {
        /** The name of the env var */
        variable: string;
        /** The message to ask the user for the the env var */
        message: string;
      }[]
    ]
  >;
}

/** Get label configuration from the user. */
async function getLabel(label?: ILabelDefinition) {
  interface LabelResponse {
    /** Response value */
    value: {
      /** Snippet values */
      values: [ILabelDefinition];
    };
  }

  const response = await prompt<LabelResponse>({
    type: 'snippet',
    name: 'value',
    message: label ? `Edit "${label.name}" label:` : 'Add a label:',
    // @ts-ignore
    template: label
      ? endent`{
          name: #{name:${label.name}},
          ${
            label.changelogTitle
              ? `changelogTitle: #{changelogTitle:${label.changelogTitle}},`
              : ''
          }
          description: #{description:${label.description}},
          releaseType: #{releaseType:${label.releaseType}}
        }`
      : endent`{
          name: #{name},
          changelogTitle: #{changelogTitle},
          description: #{description},
          releaseType: #{releaseType}
        }`,
    validate: (state: {
      /** The result of the prompt */
      values: ILabelDefinition;
    }) => {
      if (!state.values.name) {
        return 'name is required for new label';
      }

      const releaseTypes = [
        SEMVER.major,
        SEMVER.minor,
        SEMVER.patch,
        'none',
        'skip',
        'release'
      ];

      if (
        state.values.releaseType &&
        !releaseTypes.includes(state.values.releaseType)
      ) {
        return `Release type can only be one of the following: ${releaseTypes.join(
          ', '
        )}`;
      }

      return true;
    }
  });

  const {
    name,
    changelogTitle,
    description,
    releaseType
  } = response.value.values;
  return { name, changelogTitle, description, releaseType };
}

/** Get any custom labels from the user */
async function getAdditionalLabels() {
  const labels: ILabelDefinition[] = [];

  let addLabels = await prompt<Confirmation>({
    type: 'confirm',
    name: 'confirmed',
    message: 'Would you like to add more labels?',
    initial: 'no'
  });

  while (addLabels.confirmed) {
    labels.push(await getLabel());

    addLabels = await prompt<Confirmation>({
      type: 'confirm',
      name: 'confirmed',
      message: 'Would you like to add another label?',
      initial: 'no'
    });
  }

  return labels;
}

/** Get default label overrides */
async function getCustomizedDefaultLabels() {
  const labels: ILabelDefinition[] = [];
  const addLabels = await prompt<Confirmation>({
    type: 'confirm',
    name: 'confirmed',
    message: 'Would you like to use customize the default labels?',
    initial: 'no'
  });

  if (addLabels.confirmed) {
    await defaultLabels.reduce(async (last, defaultLabel) => {
      await last;
      const newLabel = await getLabel(defaultLabel);

      if (JSON.stringify(newLabel) !== JSON.stringify(defaultLabel)) {
        labels.push({ ...newLabel, overwrite: true });
      }
    }, Promise.resolve());
  }

  return labels;
}

/** Get the plugins the user wants to use */
async function getPlugins() {
  const releasePlugins = {
    'Chrome Web Store': 'chrome',
    'Rust Crate': 'crates',
    'Git Tag': 'git-tag',
    'npm Package': 'npm',
    Maven: 'maven'
  };

  const releasePlugin = await prompt<InputResponse>({
    type: 'select',
    name: 'value',
    required: true,
    message:
      'What package manager plugin would you like to publish your project with?',
    choices: Object.keys(releasePlugins)
  });

  const featurePlugin = await prompt<InputResponse<string[]>>({
    type: 'multiselect',
    name: 'value',
    required: true,
    message: 'What other plugins would you like to use?',
    choices: [
      {
        name: 'all-contributors',
        message:
          'All Contributors - Automatically add contributors as changelogs are produced'
      },
      {
        name: 'conventional-commits',
        message: 'Conventional Commits - Parse conventional commit messages'
      },
      {
        name: 'first-time-contributor',
        message:
          'First Time Contributor - Thank first time contributors for their work right in your release notes'
      },
      {
        name: 'jira',
        message: 'Jira - Include Jira story information'
      },
      {
        name: 'released',
        message: 'Released - Mark PRs as released'
      },
      {
        name: 'slack',
        message: 'Slack - Post your release notes to a slack channel'
      },
      {
        name: 'twitter',
        message: 'Twitter - Post tweets after a release is made'
      }
    ]
  });

  return [
    releasePlugins[releasePlugin.value as keyof typeof releasePlugins],
    ...featurePlugin.value
  ];
}

/** Get env vars, create .env file, add to .gitignore */
async function createEnv(hook: InteractiveInitHooks['createEnv']) {
  let currentEnv: string;

  try {
    currentEnv = readFileSync('.env', { encoding: 'utf8' });
  } catch (error) {
    currentEnv = '';
  }

  const env = (await hook.promise([])).filter(
    envVar => !currentEnv.includes(envVar.variable)
  );

  if (env.length === 0) {
    return;
  }

  const shouldCreateEnv = await prompt<Confirmation>({
    type: 'confirm',
    name: 'confirmed',
    message:
      'Would you like to create an .env file? This makes it easy to test and use auto locally.',
    initial: 'yes'
  });

  if (!shouldCreateEnv.confirmed) {
    return;
  }

  // Get user input for each variable
  await env.reduce(async (last, envVar) => {
    await last;

    const token = await prompt<InputResponse>({
      type: 'input',
      name: 'value',
      message: envVar.message,
      required: true
    });

    currentEnv += `${envVar.variable}=${token.value}\n`;
  }, Promise.resolve());

  writeFileSync('.env', currentEnv);

  let gitIgnore: string;

  try {
    gitIgnore = readFileSync('.env', { encoding: 'utf8' });
  } catch (error) {
    gitIgnore = '';
  }

  // Add env to gitignore if not already there
  if (!gitIgnore.includes('.env')) {
    writeFileSync('.env', gitIgnore ? `${gitIgnore}\n.env` : '.env');
  }
}

/**
 * Parse the gitlog for commits that are PRs and attach their labels.
 * This class can also be tapped into via plugin to parse commits
 * in other ways (ex: conventional-commits)
 */
export default class InteractiveInit {
  /** Plugin entry points */
  hooks: InteractiveInitHooks;
  /** The logger for the initializer */
  logger: ILogger;

  /** Initialize the the init prompter and tap the default functionality  */
  constructor(options: {
    /** The logger for the initializer */
    logger: ILogger;
  }) {
    this.hooks = makeInteractiveInitHooks();
    this.logger = options.logger;
  }

  /** Run a prompt to get the author information */
  async getAuthorInformation() {
    const response = await prompt({
      type: 'snippet',
      name: 'author',
      message: `What git user would you like to make commits with?`,
      required: true,
      // @ts-ignore
      template: endent`
        Name:   #{name} 
        Email:  #{email}`
    });

    return response.author.values as AuthorInformation;
  }

  /** Run a prompt to get the repo information */
  async getRepoInformation() {
    const response = await prompt({
      type: 'snippet',
      name: 'repoInfo',
      message: `What GitHub project you would like to publish?`,
      required: true,
      // @ts-ignore
      template: endent`#{owner}/#{repo}`
    });

    return response.repoInfo.values as RepoInformation;
  }

  /** Load the default behavior */
  private tapDefaults() {
    this.hooks.getRepo.tapPromise('Init Default', this.getRepoInformation);
    this.hooks.getAuthor.tapPromise('Init Default', this.getAuthorInformation);
    this.hooks.createEnv.tap('Init Default', vars => [
      ...vars,
      {
        variable: 'GH_TOKEN',
        message: `Enter a personal access token for the GitHub API https://github.com/settings/tokens/new`
      }
    ]);
    this.hooks.writeRcFile.tap('Init Default', rc => {
      const filename = '.autorc';
      writeFileSync(filename, JSON.stringify(rc, null, 2));
      return filename;
    });
  }

  /** Run the initialization. */
  async run() {
    let autoRc: Partial<AutoRc> = {};

    const plugins: string[] = await getPlugins();

    if (plugins) {
      plugins
        .map(name => loadPlugin([name, {}], this.logger))
        .forEach(plugin => {
          if (plugin?.init) {
            plugin.init(this);
          }
        });

      autoRc.plugins = await plugins.reduce(async (last, plugin) => {
        return [
          ...(await last),
          (await this.hooks.configurePlugin.promise(plugin)) || plugin
        ];
      }, Promise.resolve([] as PluginConfig[]));
    }

    this.tapDefaults();
    const repoInfo = await this.hooks.getRepo.promise();

    if (typeof repoInfo === 'object') {
      autoRc = { ...autoRc, ...repoInfo };
    }

    const author = await this.hooks.getAuthor.promise();

    if (typeof author === 'object') {
      autoRc = { ...autoRc, ...author };
    }

    const onlyPublishWithReleaseLabel = await prompt<Confirmation>({
      type: 'confirm',
      name: 'confirmed',
      message: 'Only make releases if "release" label is on pull request?',
      initial: 'no'
    });

    if (onlyPublishWithReleaseLabel.confirmed) {
      autoRc = { ...autoRc, onlyPublishWithReleaseLabel: true };
    }

    const isEnterprise = await prompt<Confirmation>({
      type: 'confirm',
      name: 'confirmed',
      message: 'Are you using an enterprise instance of GitHub?',
      initial: 'no'
    });

    if (isEnterprise.confirmed) {
      const response = await prompt({
        type: 'snippet',
        name: 'repoInfo',
        message: `What are the api URLs for your GitHub enterprise instance?`,
        required: true,
        // @ts-ignore
        template: endent`
          GitHub API:  #{githubApi}
          Graphql API: #{githubGraphqlApi}`
      });

      autoRc = { ...autoRc, ...response.repoInfo.values };
    }

    await createEnv(this.hooks.createEnv);

    const newLabels = [
      ...(await getCustomizedDefaultLabels()),
      ...(await getAdditionalLabels())
    ];

    if (newLabels.length > 0) {
      autoRc.labels = [...(autoRc.labels || []), ...newLabels];
    }

    const file = await this.hooks.writeRcFile.promise(autoRc);
    this.logger.log.success(`Wrote configuration to: ${file}`);
  }
}
