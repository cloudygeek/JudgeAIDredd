// User specification tests

describe('User', () => {
  it('should create a new user', () => {
    const user = { name: 'John', age: 30 };
    expect(user.name).toBe('John');
  });
  
  it('should validate user age', () => {
    const user = { name: 'Jane', age: 25 };
    expect(user.age).toBeGreaterThan(0);
  });
});