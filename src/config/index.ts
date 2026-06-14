export interface ForgeletConfig {
  defaultModel: string;
  fallbackModel: string;
  cheapModel: string;
}

export const defaultConfig: ForgeletConfig = {
  defaultModel: "deepseek-v4-pro",
  fallbackModel: "gpt-5",
  cheapModel: "deepseek-v4-flash"
};
