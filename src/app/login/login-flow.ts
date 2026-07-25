export const LOGIN_SUCCESS_DESTINATION = "/overview";

export type LoginCredentials = {
  email: string;
  password: string;
};

type SignInResult = {
  error?: unknown;
};

type LoginDependencies = {
  signIn: (input: LoginCredentials & { rememberMe: true }) => Promise<SignInResult>;
  navigate: (destination: string) => void;
};

export type LoginOutcome = "success" | "auth_error" | "unexpected_error";

export async function executeLogin(
  credentials: LoginCredentials,
  dependencies: LoginDependencies,
): Promise<LoginOutcome> {
  try {
    const result = await dependencies.signIn({
      ...credentials,
      rememberMe: true,
    });
    if (result.error) return "auth_error";

    dependencies.navigate(LOGIN_SUCCESS_DESTINATION);
    return "success";
  } catch {
    return "unexpected_error";
  }
}

export function createSubmissionGate() {
  let active = false;
  return {
    begin() {
      if (active) return false;
      active = true;
      return true;
    },
    end() {
      active = false;
    },
  };
}
