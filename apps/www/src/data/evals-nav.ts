export interface EvalsNavItem {
	slug: string;
	label: string;
}

export interface EvalsNavSection {
	title: string;
	items: EvalsNavItem[];
}

export const evalsNav: EvalsNavSection[] = [
	{
		title: 'Getting Started',
		items: [
			{ slug: 'introduction', label: 'Introduction' },
			{ slug: 'skills', label: 'Drive it with Claude' },
			{ slug: 'getting-started', label: 'Install & first run' },
			{ slug: 'workspaces', label: 'Workspaces & overlays' },
			{ slug: 'models', label: 'Models' },
		],
	},
	{
		title: 'Authoring',
		items: [
			{ slug: 'authoring', label: 'Authoring cases' },
		],
	},
	{
		title: 'Running',
		items: [
			{ slug: 'running-evals', label: 'Running evals' },
			{ slug: 'triage', label: 'Triage' },
			{ slug: 'code-fix', label: 'Code fix' },
			{ slug: 'pr-review', label: 'PR review' },
		],
	},
	{
		title: 'Improving',
		items: [
			{ slug: 'improve', label: 'Improving the score' },
		],
	},
	{
		title: 'Reference',
		items: [
			{ slug: 'dashboard', label: 'The dashboard' },
		],
	},
];

export function findEvalTitle(slug: string): string {
	for (const section of evalsNav) {
		for (const item of section.items) {
			if (item.slug === slug) return item.label;
		}
	}
	return slug;
}
