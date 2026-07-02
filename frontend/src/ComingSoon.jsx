import React from 'react';

export default function ComingSoon({ title }) {
  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">{title}</h1>
      </div>
      <div className="card">
        <div className="empty-state">Этот раздел скоро будет 🚧</div>
      </div>
    </div>
  );
}
