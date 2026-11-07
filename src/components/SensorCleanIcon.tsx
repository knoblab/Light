import React from 'react';

interface SensorCleanIconProps {
  className?: string;
  size?: number;
}

export const SensorCleanIcon: React.FC<SensorCleanIconProps> = ({
  className = 'w-5 h-5',
  size,
}) => {
  const style = size ? { width: size, height: size } : undefined;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      className={`shrink-0 select-none ${className}`}
      style={style}
      fill="none"
      role="img"
      aria-label="SensorClean"
    >
      <rect width="128" height="128" rx="28" fill="#2B2B2E" />
      <path
        d="M16 46h12M16 64h12M16 82h12M100 46h12M100 64h12M100 82h12"
        stroke="#C2C1BB"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <rect x="28" y="28" width="72" height="72" rx="10" stroke="#C2C1BB" strokeWidth="6" />
      <circle cx="64" cy="64" r="17" stroke="#8FA06F" strokeWidth="6" strokeDasharray="7 5" />
      <circle cx="64" cy="64" r="4.5" fill="#8FA06F" />
    </svg>
  );
};
