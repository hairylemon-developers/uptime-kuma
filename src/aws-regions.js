/**
 * AWS commercial Regions from:
 * https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html
 * (excludes GovCloud and China, which require separate account types)
 * @type {{ id: string, name: string, optInRequired: boolean }[]}
 */
export const AWS_REGIONS = [
    { id: "us-east-1", name: "US East (N. Virginia)", optInRequired: false },
    { id: "us-east-2", name: "US East (Ohio)", optInRequired: false },
    { id: "us-west-1", name: "US West (N. California)", optInRequired: false },
    { id: "us-west-2", name: "US West (Oregon)", optInRequired: false },
    { id: "af-south-1", name: "Africa (Cape Town)", optInRequired: true },
    { id: "ap-east-1", name: "Asia Pacific (Hong Kong)", optInRequired: true },
    { id: "ap-south-2", name: "Asia Pacific (Hyderabad)", optInRequired: true },
    { id: "ap-southeast-3", name: "Asia Pacific (Jakarta)", optInRequired: true },
    { id: "ap-southeast-5", name: "Asia Pacific (Malaysia)", optInRequired: true },
    { id: "ap-southeast-4", name: "Asia Pacific (Melbourne)", optInRequired: true },
    { id: "ap-south-1", name: "Asia Pacific (Mumbai)", optInRequired: false },
    { id: "ap-southeast-6", name: "Asia Pacific (New Zealand)", optInRequired: true },
    { id: "ap-northeast-3", name: "Asia Pacific (Osaka)", optInRequired: false },
    { id: "ap-northeast-2", name: "Asia Pacific (Seoul)", optInRequired: false },
    { id: "ap-southeast-1", name: "Asia Pacific (Singapore)", optInRequired: false },
    { id: "ap-southeast-2", name: "Asia Pacific (Sydney)", optInRequired: false },
    { id: "ap-east-2", name: "Asia Pacific (Taipei)", optInRequired: true },
    { id: "ap-southeast-7", name: "Asia Pacific (Thailand)", optInRequired: true },
    { id: "ap-northeast-1", name: "Asia Pacific (Tokyo)", optInRequired: false },
    { id: "ca-central-1", name: "Canada (Central)", optInRequired: false },
    { id: "ca-west-1", name: "Canada West (Calgary)", optInRequired: true },
    { id: "eu-central-1", name: "Europe (Frankfurt)", optInRequired: false },
    { id: "eu-west-1", name: "Europe (Ireland)", optInRequired: false },
    { id: "eu-west-2", name: "Europe (London)", optInRequired: false },
    { id: "eu-south-1", name: "Europe (Milan)", optInRequired: true },
    { id: "eu-west-3", name: "Europe (Paris)", optInRequired: false },
    { id: "eu-south-2", name: "Europe (Spain)", optInRequired: true },
    { id: "eu-north-1", name: "Europe (Stockholm)", optInRequired: false },
    { id: "eu-central-2", name: "Europe (Zurich)", optInRequired: true },
    { id: "il-central-1", name: "Israel (Tel Aviv)", optInRequired: true },
    { id: "mx-central-1", name: "Mexico (Central)", optInRequired: true },
    { id: "me-south-1", name: "Middle East (Bahrain)", optInRequired: true },
    { id: "me-central-1", name: "Middle East (UAE)", optInRequired: true },
    { id: "sa-east-1", name: "South America (São Paulo)", optInRequired: false },
];

/**
 * @param {string} regionId
 * @returns {string}
 */
export function awsRegionLabel(regionId) {
    if (!regionId) {
        return "";
    }
    const match = AWS_REGIONS.find((r) => r.id === regionId);
    return match ? `${match.name} (${match.id})` : regionId;
}
