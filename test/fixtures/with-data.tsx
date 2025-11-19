// Component with data from constants and imports
import { API_URL } from './constants';

const COLORS = {
  primary: 'blue',
  secondary: 'green',
};

const TEAM_MEMBERS = [
  { name: 'Alice', role: 'Engineer' },
  { name: 'Bob', role: 'Designer' },
];

export default function WithData() {
  const apiKey = process.env.API_KEY;

  return (
    <div>
      <div style={{ color: COLORS.primary }}>
        Primary Color
      </div>
      <ul>
        {TEAM_MEMBERS.map(member => (
          <li key={member.name}>
            {member.name} - {member.role}
          </li>
        ))}
      </ul>
      <code>API: {API_URL}</code>
    </div>
  );
}
