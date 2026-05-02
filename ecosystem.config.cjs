module.exports = {
  apps: [{
    name: "talk-to-myself",
    script: "npm",
    args: "run dev -- --port 3004 --host",
    cwd: "/var/www/www.selinmodel.com/talktomyself",
    watch: false,
    env: {
      NODE_ENV: "production",
    }
  }]
};
