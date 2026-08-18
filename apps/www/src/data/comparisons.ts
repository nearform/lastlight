/**
 * The comparison set.
 *
 * Each entry gets its own page at /comparisons/<slug>/ so it can target the
 * query people actually type ("devin alternative", "self-hosted software
 * factory") instead of all of them competing inside one monolithic page.
 * /comparisons/ stays the hub and links to every one of these.
 */
export interface Comparison {
	slug: string;
	/** The other tool, as it should read in a heading. */
	name: string;
	/** One-line positioning used on the hub cards and the related-links nav. */
	blurb: string;
	/** Which half of the category map this tool sits in. */
	category: string;
}

export const comparisons: Comparison[] = [
	{
		slug: 'devin',
		name: 'Devin',
		blurb: 'The vendor-hosted autonomous engineer. Same issue→PR loop, someone else’s cloud.',
		category: 'Hosted · event-driven',
	},
	{
		slug: 'factory-ai',
		name: 'Factory droid',
		blurb: 'The polished commercial multi-agent platform. On-prem only at Enterprise tier.',
		category: 'Hosted · event-driven',
	},
	{
		slug: '8090',
		name: '8090',
		blurb: 'The other “software factory” — enterprise, regulated, delivered as a service.',
		category: 'Hosted · enterprise delivery',
	},
	{
		slug: 'copilot-coding-agent',
		name: 'Copilot coding agent',
		blurb: 'GitHub’s own issue→PR bot. Zero ops, zero BYO-model, zero workflow control.',
		category: 'Hosted · event-driven',
	},
	{
		slug: 'openhands',
		name: 'OpenHands',
		blurb: 'The closest OSS competitor. Self-hosted and autonomous — but one pipeline.',
		category: 'Self-hosted · event-driven',
	},
	{
		slug: 'archon',
		name: 'Archon',
		blurb: 'The closest architectural twin. A harness that drives your existing agent CLIs.',
		category: 'Self-hosted · event-driven',
	},
];

export function otherComparisons(slug: string): Comparison[] {
	return comparisons.filter((c) => c.slug !== slug);
}
