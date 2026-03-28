/**
 * Fleet management barrel export.
 */

export { ensureFactionMembership, promoteFactionMembers } from "./faction-manager";
export { discoverFactionStorage, propagateFleetHome } from "./home-discovery";
export type { DiscoveryResult } from "./home-discovery";
export {
  saveBotSettings, loadBotSettings,
  saveBotSkills, loadBotSkills,
  saveFleetSettings, loadFleetSettings,
  saveGoals, loadGoals,
} from "./persistence";
export type { BotSettingsData, BotSkillsData, FleetSettingsData } from "./persistence";
