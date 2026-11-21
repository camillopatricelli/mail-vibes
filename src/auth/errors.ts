export class AuthRequiredError extends Error {
  constructor(message = 'Sign-in required') {
    super(message)
    this.name = 'AuthRequiredError'
  }
}
