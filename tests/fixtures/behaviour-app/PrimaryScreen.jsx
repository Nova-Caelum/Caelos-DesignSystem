export function PrimaryScreen() {
  const handlePass = () => {};
  const handleFlaky = () => {};
  const handleMessage = () => {};
  const handleKeyDown = () => {};

  return (
    <main>
      <button onClick={handlePass}>Pass action</button>
      <button onClick={handleFlaky}>Flaky action</button>
      <input aria-label="Message" onChange={handleMessage} onKeyDown={handleKeyDown} />
    </main>
  );
}
