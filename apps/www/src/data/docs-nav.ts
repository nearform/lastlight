export interface DocsNavItem {
	slug: string;
	label: string;
}

export interface DocsNavSection {
	title: string;
	items: DocsNavItem[];
}

export const docsNav: DocsNavSection[] = [
	{
		title: 'Getting Started',
		items: [
			{ slug: 'quickstart', label: 'Quick start with Claude' },
			{ slug: 'introduction', label: 'Introduction' },
			{ slug: 'prerequisites', label: 'Prerequisites' },
			{ slug: 'github-app', label: 'Create a GitHub App' },
			{ slug: 'local-dev', label: 'Run it locally' },
			{ slug: 'production', label: 'Production deploy' },
			{ slug: 'slack', label: 'Slack integration' },
		],
	},
	{
		title: 'Workflows',
		items: [
			{ slug: 'workflows/overview', label: 'Overview' },
			{ slug: 'workflows/build', label: 'Build' },
			{ slug: 'workflows/explore', label: 'Explore' },
			{ slug: 'workflows/issue-triage', label: 'Issue triage' },
			{ slug: 'workflows/issue-comment', label: 'Issue comment' },
			{ slug: 'workflows/answer', label: 'Answer' },
			{ slug: 'workflows/pr-comment', label: 'PR comment' },
			{ slug: 'workflows/pr-review', label: 'PR review' },
			{ slug: 'workflows/pr-fix', label: 'PR fix' },
			{ slug: 'workflows/repo-health', label: 'Repo health' },
			{ slug: 'workflows/security-review', label: 'Security review' },
			{ slug: 'workflows/security-feedback', label: 'Security feedback' },
			{ slug: 'workflows/verify', label: 'Verify' },
			{ slug: 'workflows/qa-test', label: 'QA test' },
			{ slug: 'workflows/demo', label: 'Demo' },
		],
	},
	{
		title: 'Reference',
		items: [
			{ slug: 'configuration', label: 'Configuration' },
			{ slug: 'observability', label: 'Observability' },
			{ slug: 'cli', label: 'CLI' },
		],
	},
];

export function findDocTitle(slug: string): string {
	for (const section of docsNav) {
		for (const item of section.items) {
			if (item.slug === slug) return item.label;
		}
	}
	return slug;
}
